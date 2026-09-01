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
 * The password is the only entropy in password mode, so this floor plus PBKDF2's 650,000
 * iterations is what stands between a leaked `wrappedDek` and the vault. The server never sees
 * it, so this is the only place to refuse.
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

/** The tail every unlock shares. Opening the store can still refuse (no IndexedDB), so it runs last. */
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
  // The Worker sets the Better Auth credential inside this call: its `setPassword` is serverOnly.
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
 * `createVault()` is a fresh DEK, and every existing ciphertext is bound to the previous one;
 * the server cannot tell a new DEK from a rewrap. A wipe goes through `resetVault`, a mode
 * change through `switchModeTo*`. This is for the message only: `isNewVault: true` on the
 * finalisation is the guarantee (a plain INSERT, so one creator commits).
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
 * An orphaned credential stays in the chooser and is refused at sign-in for having no wrap.
 * Better Auth rejects only on transport failure, so the resolved `{ error }` is checked too.
 * Takes the passkey row id: `/passkey/delete-passkey` deletes by `field: 'id'`.
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
 * With `returnWebAuthnResponse` the WebAuthn half lives on `webauthn`, not `data` (the server's
 * verify response). `response.id` is the base64url credential id every wrap lookup takes;
 * `data.id` on registration is Better Auth's row id, which only deletion wants.
 */
type PasskeyCeremony = {
  /** base64url WebAuthn credential id: `allowCredentials`, and wrap lookup. */
  readonly credentialId: string;
  /** Better Auth's passkey row id, for `/passkey/delete-passkey`. The Worker matches each id only in its own column. */
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
 * `create()` associates the PRF key but does not reliably return PRF output, so the bytes come
 * from a scoped assertion afterwards, on every hardware. A failure at any step deletes the
 * provisional passkey.
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
  // Not a mode switch: the finalisation sets `unlock_mode = 'passkey'` and deletes the
  // password credential. `switchModeToPasskey` is the deliberate version.
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

/** The server's view of the vault as one string; the only thing that can notice a reset or re-enrolment elsewhere. */
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

/** Reopen with persisted keys if the server still describes the vault they were saved against; stale keys are forgotten. */
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
