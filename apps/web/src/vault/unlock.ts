import {
  createVault,
  deriveAccountKeys,
  derivePasskeyEncKey,
  openVault,
  rewrapDek,
  type Vault,
} from '@yozz.app/vault';
import type { UnlockStatusResponse } from '@yozz.app/vault-contract';
import { type VaultApiClient, vaultApi } from './api.ts';
import {
  addPasskeyAuthenticator as authAddPasskey,
  signInWithPasskey as authSignInPasskey,
  signInWithPassword as authSignInPassword,
  deletePasskeyAuthenticator,
  getSession,
} from './auth-client.ts';
import {
  checkPasskeyPrfCapability,
  evaluatePrfForCredential,
  extractPrfOutput,
  getPrfEnableInput,
  getPrfEvalInput,
  isPrfEnabled,
  PasskeyPrfError,
} from './passkey-prf.ts';
import { createRecordStore, type RecordStore } from './record-store.ts';
import { forgetUnlockKeys, loadUnlockKeys, type UnlockKeys } from './unlock-keys.ts';

/**
 * The password is the ONLY entropy in password mode — nothing device-local sits beside it — so
 * this floor is what stands between a leaked `wrappedDek` and the vault, together with PBKDF2's
 * 650,000 iterations. Twelve rather than eight for that reason, and the copy asks for a
 * passphrase rather than a password. The server never sees it, so this is the only place to
 * refuse.
 */
export const MIN_PASSWORD_LENGTH = 12;

const refuseShortPassword = (password: string) => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UnlockError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
};

export class UnlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockError';
  }
}

export type UnlockedVaultSession = {
  readonly userId: string;
  readonly email: string;
  readonly mode: 'password' | 'passkey';
  /** What wraps the DEK on this device; `rewrapDek` needs it to change mode. */
  readonly encKey: CryptoKey;
  readonly wrappedDek: string;
  readonly vault: Vault;
  readonly store: RecordStore;
};

const resolveUser = async (): Promise<{ userId: string; email: string }> => {
  const session = await getSession();
  if (!session?.data?.user) {
    throw new UnlockError('No authenticated Better Auth session found');
  }
  return {
    userId: session.data.user.id,
    email: session.data.user.email,
  };
};

/**
 * The tail every unlock shares: the Better Auth session names the user, and
 * the record store opens over that user's revision marks. Opening the store is
 * what can still refuse here (no IndexedDB), so it runs last.
 */
const openSession = async ({
  mode,
  encKey,
  wrappedDek,
  vault,
  api,
  idbFactory,
}: {
  readonly mode: 'password' | 'passkey';
  readonly encKey: CryptoKey;
  readonly wrappedDek: string;
  readonly vault: Vault;
  readonly api: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  const { userId, email } = await resolveUser();
  const store = await createRecordStore({ userId, rawVault: vault, api, idbFactory });
  return { userId, email, mode, encKey, wrappedDek, vault, store };
};

export const createPasswordVault = async ({
  email,
  password,
  api = vaultApi,
  idbFactory,
}: {
  readonly email: string;
  readonly password: string;
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  refuseShortPassword(password);
  await refuseIfAlreadyEnrolled(api);

  const keys = await deriveAccountKeys({ email, password });

  const { vault, wrappedDek } = await createVault(keys);
  // The Worker sets the Better Auth credential inside this same call: its
  // `setPassword` is serverOnly and has no HTTP path, so the browser cannot
  // create the credential itself.
  await api.finalizePasswordUnlock({ isNewVault: true, wrappedDek, authValue: keys.authValue });

  return openSession({ mode: 'password', encKey: keys.encKey, wrappedDek, vault, api, idbFactory });
};

export const loginWithPassword = async ({
  email,
  password,
  api = vaultApi,
  idbFactory,
}: {
  readonly email: string;
  readonly password: string;
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  const keys = await deriveAccountKeys({ email, password });

  const signinRes = await authSignInPassword(email, keys.authValue);
  if (signinRes.error) {
    throw new UnlockError(signinRes.error.message || 'Password sign-in failed');
  }

  const status = await api.getUnlockStatus();
  if (status.mode !== 'password') {
    throw new UnlockError(`Account is not in password mode, found: ${status.mode}`);
  }

  const vault = await openVault(keys, status.wrappedDek);
  return openSession({
    mode: 'password',
    encKey: keys.encKey,
    wrappedDek: status.wrappedDek,
    vault,
    api,
    idbFactory,
  });
};

/**
 * Refuse to MINT a new DEK over an account that already has one.
 *
 * `createPasswordVault` / `createPasskeyVault` call `createVault()`, which is a
 * fresh random DEK, and finalisation upserts the wrap. Every existing
 * ciphertext is bound to the previous DEK, so running a create against an
 * enrolled account silently strands the whole vault — and the server cannot
 * tell a new DEK from a rewrap, because both arrive as opaque wrapped bytes.
 * The guard therefore has to live here.
 *
 * A deliberate wipe goes through `resetVault` first; changing unlock mode on a
 * live vault goes through `switchModeTo*`, which rewraps the SAME DEK.
 *
 * This check is for the MESSAGE, not the guarantee: two tabs can both pass it.
 * The guarantee is `isNewVault: true` on the finalisation, which the Worker
 * turns into a plain INSERT so exactly one creator commits and the other gets
 * 409 with its DEK wrapping nothing.
 */
const refuseIfAlreadyEnrolled = async (api: VaultApiClient): Promise<void> => {
  const status = await api.getUnlockStatus();
  if (status.mode !== null) {
    throw new UnlockError(
      `This account already has a ${status.mode} vault. Switch modes to keep it, or reset the vault first — creating one now would mint a new key and strand every existing record.`,
    );
  }
};

/**
 * Remove a passkey that was registered but never wrapped, and REPORT it if that
 * fails.
 *
 * An orphaned credential stays in the user's chooser and is refused at sign-in
 * for having no wrap, which reads as "my passkey stopped working" with nothing
 * pointing at the enrolment that left it. `.catch(() => {})` hid that, and so
 * did ignoring Better Auth's resolved `{ error }` — it rejects only on
 * transport failure.
 *
 * Takes the passkey ROW id. `/passkey/delete-passkey` deletes by `field: 'id'`,
 * so addressing it with the WebAuthn credential id deletes nothing and then
 * reports a failure that never happened.
 *
 * One helper because there are four call sites: enrolment, and the three
 * finalisation paths. Fixing the one a review named would have left three.
 */
const discardProvisionalPasskey = async (credentialId: string, cause: unknown): Promise<never> => {
  if (!credentialId) throw cause;
  const result = await deletePasskeyAuthenticator(credentialId).catch(err => ({ error: err }));
  if ((result as { error?: unknown } | undefined)?.error) {
    throw new PasskeyPrfError(
      `${cause instanceof Error ? cause.message : String(cause)} — and the provisional passkey could not be removed; delete it from your authenticator`,
    );
  }
  throw cause;
};

/**
 * Better Auth's passkey client returns `{ ...verified, webauthn: { response,
 * clientExtensionResults } }` when `returnWebAuthnResponse` is set, so the
 * WebAuthn half lives on `webauthn` and NOT on `data` — `data` is the server's
 * verify response, the persisted passkey row on registration and the session on
 * authentication.
 *
 * Reading `data.clientExtensionResults` therefore yields `undefined` on every
 * path, which silently disables PRF entirely. It went unnoticed because the
 * tests built their own response objects in the shape the code expected rather
 * than the shape the plugin returns. One accessor, used everywhere, so the two
 * cannot drift apart again.
 *
 * `response.id` is the base64url WebAuthn CREDENTIAL id, which is what every
 * wrap lookup and finalisation takes. `data.id` on registration is Better
 * Auth's row id, which `allowCredentials` cannot use and only deletion wants.
 */
type PasskeyCeremony = {
  /** base64url WebAuthn credential id — `allowCredentials`, and wrap lookup. */
  readonly credentialId: string;
  /**
   * Better Auth's passkey ROW id. Not interchangeable with the credential id:
   * `POST /passkey/delete-passkey` resolves `where: [{ field: 'id' }]`, so a
   * deletion addressed by credential id matches nothing and the orphan
   * survives. The Worker matches each id only in its own column, so the
   * mix-up fails loudly there rather than silently.
   */
  readonly rowId: string;
  readonly clientExtensionResults: unknown;
};

const readCeremony = (result: unknown): PasskeyCeremony => {
  const webauthn = (
    result as { webauthn?: { response?: { id?: string }; clientExtensionResults?: unknown } }
  )?.webauthn;
  const rowId = (result as { data?: { id?: string } })?.data?.id ?? '';
  if (!webauthn) {
    throw new PasskeyPrfError(
      'The passkey client returned no WebAuthn response; returnWebAuthnResponse must be set',
    );
  }
  const credentialId = webauthn.response?.id;
  if (!credentialId) {
    throw new PasskeyPrfError('The passkey ceremony returned no credential id');
  }
  return { credentialId, rowId, clientExtensionResults: webauthn.clientExtensionResults };
};

/**
 * Register an authenticator and get its PRF bytes — the two ceremonies that
 * enrolment actually needs.
 *
 * `create()` associates the PRF key; it does not reliably return PRF output.
 * So the bytes come from a scoped local assertion afterwards. Two prompts at
 * enrolment, one code path: an opportunistic version that used `create()`
 * results when present would leave the assertion path firing only on some
 * hardware, which is a path that rots unnoticed.
 *
 * A failure at any step deletes the provisional passkey, so a browser that
 * cannot do PRF does not leave a credential behind that could later satisfy a
 * sign-in it has no wrap for.
 */
const enrolPrfPasskey = async (): Promise<{
  readonly credentialId: string;
  readonly rowId: string;
  readonly encKey: CryptoKey;
}> => {
  if ((await checkPasskeyPrfCapability()) === 'unsupported') {
    throw new PasskeyPrfError('This browser cannot use the WebAuthn PRF extension');
  }

  const regRes = await authAddPasskey(getPrfEnableInput());
  if (regRes.error || !regRes.data) {
    throw new PasskeyPrfError(regRes.error?.message || 'Passkey registration failed');
  }

  const { credentialId, rowId, clientExtensionResults } = readCeremony(regRes);

  try {
    if (!isPrfEnabled(clientExtensionResults)) {
      throw new PasskeyPrfError('This authenticator cannot use the WebAuthn PRF extension');
    }
    return {
      credentialId,
      rowId,
      encKey: await derivePasskeyEncKey(await evaluatePrfForCredential(credentialId)),
    };
  } catch (err) {
    return discardProvisionalPasskey(rowId, err);
  }
};

export const createPasskeyVault = async ({
  api = vaultApi,
  idbFactory,
}: {
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
} = {}): Promise<UnlockedVaultSession> => {
  await refuseIfAlreadyEnrolled(api);

  const { credentialId, rowId, encKey } = await enrolPrfPasskey();
  const { vault, wrappedDek } = await createVault({ encKey });

  try {
    await api.finalizePasskeyUnlock({ isNewVault: true, credentialId, wrappedDek });
  } catch (err) {
    return discardProvisionalPasskey(rowId, err);
  }

  return openSession({ mode: 'passkey', encKey, wrappedDek, vault, api, idbFactory });
};

export const loginWithPasskey = async ({
  api = vaultApi,
  idbFactory,
}: {
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
} = {}): Promise<UnlockedVaultSession> => {
  const authRes = await authSignInPasskey(getPrfEvalInput());
  if (authRes.error || !authRes.data) {
    throw new PasskeyPrfError(authRes.error?.message || 'Passkey sign-in failed');
  }

  const { credentialId, clientExtensionResults } = readCeremony(authRes);
  const encKey = await derivePasskeyEncKey(extractPrfOutput(clientExtensionResults));

  const wrappedDek = await api.getPasskeyWrap(credentialId);
  const vault = await openVault({ encKey }, wrappedDek);
  return openSession({ mode: 'passkey', encKey, wrappedDek, vault, api, idbFactory });
};

export const addPasskeyToSession = async ({
  currentSession,
  api = vaultApi,
}: {
  readonly currentSession: UnlockedVaultSession;
  readonly api?: VaultApiClient;
}): Promise<void> => {
  /**
   * Adding an authenticator is NOT a mode switch, and the finalisation it calls
   * cannot tell the difference: that SQL sets `unlock_mode = 'passkey'`, nulls
   * the password wrap and deletes the `credential` account row. Called from a
   * password session it would destroy the password credential silently, while
   * the in-memory session still reported `mode: 'password'` — the next reload
   * simply could not unlock. `switchModeToPasskey` is the deliberate version.
   */
  if (currentSession.mode !== 'passkey') {
    throw new PasskeyPrfError(
      'This account is in password mode; use switchModeToPasskey to change mode, not addPasskeyToSession',
    );
  }

  const { credentialId, rowId, encKey } = await enrolPrfPasskey();
  const newWrappedDek = await rewrapDek(currentSession, { encKey }, currentSession.wrappedDek);

  try {
    await api.finalizePasskeyUnlock({ isNewVault: false, credentialId, wrappedDek: newWrappedDek });
  } catch (err) {
    return discardProvisionalPasskey(rowId, err);
  }
};

export const switchModeToPassword = async ({
  currentSession,
  password,
  email = currentSession.email,
  api = vaultApi,
}: {
  readonly currentSession: UnlockedVaultSession;
  readonly password: string;
  readonly email?: string;
  readonly api?: VaultApiClient;
}): Promise<UnlockedVaultSession> => {
  refuseShortPassword(password);

  const newKeys = await deriveAccountKeys({ email, password });
  const newWrappedDek = await rewrapDek(currentSession, newKeys, currentSession.wrappedDek);

  await api.finalizePasswordUnlock({
    isNewVault: false,
    wrappedDek: newWrappedDek,
    authValue: newKeys.authValue,
  });

  return {
    ...currentSession,
    email,
    mode: 'password',
    encKey: newKeys.encKey,
    wrappedDek: newWrappedDek,
  };
};

export const switchModeToPasskey = async ({
  currentSession,
  api = vaultApi,
}: {
  readonly currentSession: UnlockedVaultSession;
  readonly api?: VaultApiClient;
}): Promise<UnlockedVaultSession> => {
  const { credentialId, rowId, encKey } = await enrolPrfPasskey();
  const newWrappedDek = await rewrapDek(currentSession, { encKey }, currentSession.wrappedDek);

  try {
    await api.finalizePasskeyUnlock({ isNewVault: false, credentialId, wrappedDek: newWrappedDek });
  } catch (err) {
    return discardProvisionalPasskey(rowId, err);
  }

  return { ...currentSession, mode: 'passkey', encKey, wrappedDek: newWrappedDek };
};

/**
 * The server's view of the vault as one string. A stored `encKey` + `wrappedDek` pair stays
 * mutually valid forever, so nothing local can notice a reset or a re-enrolment from another
 * device; this is what can. Adding a passkey changes it too, which only costs one re-login.
 */
export const vaultStamp = (status: UnlockStatusResponse): string => {
  switch (status.mode) {
    case null:
      return 'none';
    case 'password':
      return `password:${status.updatedAt}`;
    case 'passkey':
      return `passkey:${status.passkeys
        .map(p => p.passkeyId)
        .sort()
        .join(',')}`;
  }
};

/** What `VaultProvider` persists after an unlock; `null` when the server cannot be asked. */
export const unlockKeysOf = async (
  session: UnlockedVaultSession,
  api: VaultApiClient = vaultApi,
): Promise<UnlockKeys> => ({
  userId: session.userId,
  mode: session.mode,
  encKey: session.encKey,
  wrappedDek: session.wrappedDek,
  stamp: vaultStamp(await api.getUnlockStatus()),
});

/**
 * Reopen the vault this device already unlocked: a live Better Auth session
 * plus the unlock keys `VaultProvider` persisted for that user, provided the
 * server still describes the vault they were saved against. `null` is the
 * ordinary case — signed out, locked on this device, or the vault changed
 * elsewhere (in which case the stale keys are forgotten here).
 */
export const resumeSession = async ({
  api = vaultApi,
  idbFactory,
}: {
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
} = {}): Promise<UnlockedVaultSession | null> => {
  const auth = await getSession();
  const user = auth?.data?.user;
  if (!user) return null;

  const keys = await loadUnlockKeys(user.id, idbFactory);
  if (keys === null) return null;

  if (vaultStamp(await api.getUnlockStatus()) !== keys.stamp) {
    await forgetUnlockKeys(user.id, idbFactory);
    return null;
  }

  const vault = await openVault({ encKey: keys.encKey }, keys.wrappedDek);
  const store = await createRecordStore({ userId: user.id, rawVault: vault, api, idbFactory });
  return { ...keys, email: user.email, vault, store };
};

export const resetVaultAccount = async (api: VaultApiClient = vaultApi): Promise<void> => {
  await api.resetVault();
};
