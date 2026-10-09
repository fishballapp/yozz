import {
  createVault,
  deriveAccountKeys,
  derivePasskeyEncKey,
  openVault,
  rewrapDek,
  type Vault,
  VaultError,
} from '@yozz.app/vault';
import type { UnlockStatusResponse } from '@yozz.app/vault-contract';
import { type AccountVaultApi, type VaultApiClient, VaultApiError, vaultApi } from './api';
import {
  addPasskeyAuthenticator as authAddPasskey,
  signInWithPasskey as authSignInPasskey,
  signInWithPassword as authSignInPassword,
  deletePasskeyAuthenticator,
  getSession,
} from './auth-client';
import {
  checkPasskeyPrfCapability,
  evaluatePrfForCredential,
  extractPrfOutput,
  getPrfEnableInput,
  getPrfEvalInput,
  isPrfEnabled,
  PasskeyPrfError,
} from './passkey-prf';
import { createRecordStore, type RecordStore } from './record-store';
import { forgetUnlockKeys, loadUnlockKeys, type UnlockKeys } from './unlock-keys';

/**
 * The password is the only entropy in password mode, so this floor plus PBKDF2's 650,000 iterations
 * is what stands between a leaked `wrappedDek` and the vault. The server never sees it, so this is
 * the only place to refuse.
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

/** Who a vault belongs to; every request names `userId`, so the Worker refuses it for anyone else. */
export type VaultAccount = {
  readonly userId: string;
  readonly email: string;
};

export type UnlockedVaultSession = VaultAccount & {
  readonly mode: 'password' | 'passkey';
  /** What wraps the DEK on this device; `rewrapDek` needs it to change mode. */
  readonly encKey: CryptoKey;
  readonly wrappedDek: string;
  readonly vault: Vault;
  readonly store: RecordStore;
};

/** A vault answer that arrived after its session ended; it belongs to that user, so nobody hears it. */
export type SessionEnded = { readonly outcome: 'ended' };

const SESSION_ENDED: SessionEnded = { outcome: 'ended' };

/**
 * The account a sign-in answered for, never the cookie read back afterwards: another tab can sign in
 * between, and this tab would open its own keys over that account's vault.
 */
const accountOf = (user: { readonly id: string; readonly email: string }): VaultAccount => ({
  userId: user.id,
  email: user.email,
});

/**
 * The tail every unlock shares. Opening the store can still refuse (no IndexedDB), so it runs last.
 * The store names its account on every request.
 */
const openSession = async ({
  account,
  mode,
  encKey,
  wrappedDek,
  vault,
  api,
  idbFactory,
}: {
  readonly account: VaultAccount;
  readonly mode: 'password' | 'passkey';
  readonly encKey: CryptoKey;
  readonly wrappedDek: string;
  readonly vault: Vault;
  readonly api: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  const store = await createRecordStore({
    userId: account.userId,
    rawVault: vault,
    api: api.forAccount(account.userId),
    idbFactory,
  });
  return { ...account, mode, encKey, wrappedDek, vault, store };
};

/** `account` is the one the screen showed; the vault is created for it or not at all. */
export const createPasswordVault = async ({
  account,
  password,
  api = vaultApi,
  idbFactory,
}: {
  readonly account: VaultAccount;
  readonly password: string;
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  refuseShortPassword(password);
  const named = api.forAccount(account.userId);
  await refuseIfAlreadyEnrolled(named);

  const keys = await deriveAccountKeys({ email: account.email, password });

  const { vault, wrappedDek } = await createVault(keys);
  // The Worker sets the Better Auth credential inside this call: its `setPassword` is serverOnly.
  await named.finalizePasswordUnlock({ isNewVault: true, wrappedDek, authValue: keys.authValue });

  return openSession({
    account,
    mode: 'password',
    encKey: keys.encKey,
    wrappedDek,
    vault,
    api,
    idbFactory,
  });
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
  const account = accountOf(signinRes.data.user);

  const status = await api.forAccount(account.userId).getUnlockStatus();
  if (status.mode !== 'password') {
    throw new UnlockError(`Account is not in password mode, found: ${status.mode}`);
  }

  const vault = await openVault(keys, status.wrappedDek);
  return openSession({
    account,
    mode: 'password',
    encKey: keys.encKey,
    wrappedDek: status.wrappedDek,
    vault,
    api,
    idbFactory,
  });
};

/**
 * `createVault()` mints a fresh DEK, and every existing ciphertext is bound to the previous one;
 * the server cannot tell a new DEK from a rewrap. This check only gives the message: `isNewVault:
 * true` on the finalisation is the guarantee (a plain INSERT, so one creator commits).
 */
const refuseIfAlreadyEnrolled = async (api: AccountVaultApi): Promise<void> => {
  const status = await api.getUnlockStatus();
  if (status.mode !== null) {
    throw new UnlockError(
      `This account already has a ${status.mode} vault. Switch modes to keep it, or reset the vault first — creating one now would mint a new key and strand every existing record.`,
    );
  }
};

/**
 * An orphaned credential stays in the chooser and is refused at sign-in for having no wrap. Better
 * Auth rejects only on transport failure, so the resolved `{ error }` is checked too. Takes the
 * passkey row id: `/passkey/delete-passkey` deletes by `field: 'id'`.
 */
const discardProvisionalPasskey = async ({
  userId,
  passkeyId,
  cause,
}: {
  readonly userId: string;
  readonly passkeyId: string;
  readonly cause: unknown;
}): Promise<never> => {
  if (!passkeyId) throw cause;
  const result = await deletePasskeyAuthenticator({ userId, passkeyId }).catch(err => ({
    error: err,
  }));
  if ((result as { error?: unknown } | undefined)?.error) {
    throw new PasskeyPrfError(
      `${cause instanceof Error ? cause.message : String(cause)} — and the provisional passkey could not be removed; delete it from your authenticator`,
    );
  }
  throw cause;
};

/**
 * With `returnWebAuthnResponse` the WebAuthn half lives on `webauthn`, not `data` (the server's
 * verify response). `response.id` is the base64url credential id every wrap lookup takes; `data.id`
 * on registration is Better Auth's row id, which only deletion wants.
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

/** `create()` associates the PRF key but does not reliably return PRF output; `derivePasskeyKey` gets it. */
const registerPrfPasskey = async (userId: string): Promise<PasskeyCeremony> => {
  if ((await checkPasskeyPrfCapability()) === 'unsupported') {
    throw new PasskeyPrfError('This browser cannot use the WebAuthn PRF extension');
  }

  const regRes = await authAddPasskey({ userId, extensions: getPrfEnableInput() });
  // The error union only sometimes carries a `code`; the vault's own refusals always do.
  const code = regRes.error && 'code' in regRes.error ? regRes.error.code : undefined;
  if (code === 'SESSION_NOT_FRESH' || code === 'ACCOUNT_MISMATCH') {
    throw new VaultApiError(code, regRes.error?.message ?? code, 403);
  }
  if (regRes.error || !regRes.data) {
    throw new PasskeyPrfError(regRes.error?.message || 'Passkey registration failed');
  }

  return readCeremony(regRes);
};

/** From a scoped assertion after `create()`, on every hardware. A failure deletes the provisional passkey. */
const derivePasskeyKey = async (
  userId: string,
  { credentialId, rowId, clientExtensionResults }: PasskeyCeremony,
): Promise<CryptoKey> => {
  try {
    if (!isPrfEnabled(clientExtensionResults)) {
      throw new PasskeyPrfError('This authenticator cannot use the WebAuthn PRF extension');
    }
    return await derivePasskeyEncKey(await evaluatePrfForCredential(credentialId));
  } catch (err) {
    return discardProvisionalPasskey({ userId, passkeyId: rowId, cause: err });
  }
};

/** `account` is the one the screen showed; the vault is created for it or not at all. */
export const createPasskeyVault = async ({
  account,
  api = vaultApi,
  idbFactory,
}: {
  readonly account: VaultAccount;
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
}): Promise<UnlockedVaultSession> => {
  const named = api.forAccount(account.userId);
  await refuseIfAlreadyEnrolled(named);

  const passkey = await registerPrfPasskey(account.userId);
  const encKey = await derivePasskeyKey(account.userId, passkey);
  const { vault, wrappedDek } = await createVault({ encKey });

  try {
    await named.finalizePasskeyUnlock({
      isNewVault: true,
      credentialId: passkey.credentialId,
      wrappedDek,
    });
  } catch (err) {
    return discardProvisionalPasskey({
      userId: account.userId,
      passkeyId: passkey.rowId,
      cause: err,
    });
  }

  return openSession({ account, mode: 'passkey', encKey, wrappedDek, vault, api, idbFactory });
};

export const PASSKEY_DERIVES_ANOTHER_KEY =
  'This passkey signed you in, but on this device it derives a different vault key from the one it was set up with, which synced passkeys can do. Log in on a device where it works, or with your password, then add a passkey on this device from Settings.';

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

  const account = accountOf(authRes.data.user);
  const { credentialId, clientExtensionResults } = readCeremony(authRes);
  const encKey = await derivePasskeyEncKey(extractPrfOutput(clientExtensionResults));

  const wrappedDek = await api.forAccount(account.userId).getPasskeyWrap(credentialId);
  const vault = await openVault({ encKey }, wrappedDek).catch((error: unknown) => {
    // The server accepted the passkey, so a wrap that will not open means this device's PRF
    // output differs from the one it was enrolled with: synced passkeys need not agree
    // (docs/knowledge/webauthn-prf.md). The generic copy blamed a passphrase.
    if (error instanceof VaultError && error.code === 'unreadable') {
      throw new PasskeyPrfError(PASSKEY_DERIVES_ANOTHER_KEY);
    }
    throw error;
  });
  return openSession({
    account,
    mode: 'passkey',
    encKey,
    wrappedDek,
    vault,
    api,
    idbFactory,
  });
};

/**
 * What a change to an open session is handed. `isCurrent` is asked before each step after the
 * first, so a session the tab closed meanwhile prompts and writes nothing more; every write names
 * the session's account, so a session another tab replaced is refused by the Worker.
 */
type SessionChange = {
  readonly currentSession: UnlockedVaultSession;
  readonly isCurrent: () => boolean;
  readonly api?: VaultApiClient;
};

/** Adding a passkey and switching to one are the same writes: register it, then wrap the DEK under it. */
const wrapUnderNewPasskey = async ({
  currentSession,
  isCurrent,
  api = vaultApi,
}: SessionChange): Promise<
  | { readonly outcome: 'wrapped'; readonly encKey: CryptoKey; readonly wrappedDek: string }
  | SessionEnded
> => {
  const { userId } = currentSession;
  const passkey = await registerPrfPasskey(userId);
  // An ended session leaves the provisional passkey: what ended it took the cookie that could delete it.
  if (!isCurrent()) return SESSION_ENDED;
  const encKey = await derivePasskeyKey(userId, passkey);
  const wrappedDek = await rewrapDek(currentSession, { encKey }, currentSession.wrappedDek);
  if (!isCurrent()) return SESSION_ENDED;

  try {
    await api.forAccount(userId).finalizePasskeyUnlock({
      isNewVault: false,
      credentialId: passkey.credentialId,
      wrappedDek,
    });
  } catch (err) {
    return discardProvisionalPasskey({ userId, passkeyId: passkey.rowId, cause: err });
  }
  if (!isCurrent()) return SESSION_ENDED;
  return { outcome: 'wrapped', encKey, wrappedDek };
};

export const addPasskeyToSession = async (
  change: SessionChange,
): Promise<{ readonly outcome: 'added' } | SessionEnded> => {
  // Not a mode switch: the finalisation sets `unlock_mode = 'passkey'` and deletes the
  // password credential. `switchModeToPasskey` is the deliberate version.
  if (change.currentSession.mode !== 'passkey') {
    throw new PasskeyPrfError(
      'This account is in password mode; use switchModeToPasskey to change mode, not addPasskeyToSession',
    );
  }

  const wrapped = await wrapUnderNewPasskey(change);
  return wrapped.outcome === 'ended' ? wrapped : { outcome: 'added' };
};

/** The session as it opens after the switch, over the same store. */
type ModeSwitched = { readonly outcome: 'switched'; readonly session: UnlockedVaultSession };

export const switchModeToPassword = async ({
  currentSession,
  isCurrent,
  password,
  api = vaultApi,
}: SessionChange & { readonly password: string }): Promise<ModeSwitched | SessionEnded> => {
  refuseShortPassword(password);

  const newKeys = await deriveAccountKeys({ email: currentSession.email, password });
  const newWrappedDek = await rewrapDek(currentSession, newKeys, currentSession.wrappedDek);
  if (!isCurrent()) return SESSION_ENDED;

  await api.forAccount(currentSession.userId).finalizePasswordUnlock({
    isNewVault: false,
    wrappedDek: newWrappedDek,
    authValue: newKeys.authValue,
  });
  if (!isCurrent()) return SESSION_ENDED;

  return {
    outcome: 'switched',
    session: {
      ...currentSession,
      mode: 'password',
      encKey: newKeys.encKey,
      wrappedDek: newWrappedDek,
    },
  };
};

export const switchModeToPasskey = async (
  change: SessionChange,
): Promise<ModeSwitched | SessionEnded> => {
  const wrapped = await wrapUnderNewPasskey(change);
  if (wrapped.outcome === 'ended') return wrapped;
  return {
    outcome: 'switched',
    session: {
      ...change.currentSession,
      mode: 'passkey',
      encKey: wrapped.encKey,
      wrappedDek: wrapped.wrappedDek,
    },
  };
};

/**
 * The server refuses to change how a vault opens from a session older than a day, so a stolen
 * cookie cannot plant a credential of its own. Better Auth's passkey registration and our own
 * routes both say so as `SESSION_NOT_FRESH`.
 */
export const needsFreshSession = (error: unknown): boolean =>
  error instanceof VaultApiError && error.code === 'SESSION_NOT_FRESH';

const signInAgain = async (
  { mode, email }: UnlockedVaultSession,
  password: string | undefined,
): Promise<VaultAccount> => {
  if (mode === 'passkey') {
    const res = await authSignInPasskey();
    if (res.error || !res.data) {
      throw new PasskeyPrfError(res.error?.message || 'Passkey sign-in failed');
    }
    return accountOf(res.data.user);
  }
  if (password === undefined || password === '') {
    throw new UnlockError('Enter your current password.');
  }
  const keys = await deriveAccountKeys({ email, password });
  const res = await authSignInPassword(email, keys.authValue);
  if (res.error) throw new UnlockError('That is not the password this vault opens with.');
  return accountOf(res.data.user);
};

/**
 * A new sign-in by the vault's own method, which gives the server a fresh session; the keys this
 * tab holds are untouched. With a session open, the passkey prompt offers only this account's
 * passkeys; the account is checked anyway.
 */
export const confirmIdentity = async ({
  currentSession,
  password,
}: {
  readonly currentSession: UnlockedVaultSession;
  readonly password?: string;
}): Promise<void> => {
  const { userId } = await signInAgain(currentSession, password);
  if (userId !== currentSession.userId) {
    throw new UnlockError('That signed in to a different account.');
  }
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
  stamp: vaultStamp(await api.forAccount(session.userId).getUnlockStatus()),
});

/**
 * Reopen with persisted keys if the server still describes the vault they were saved against; stale
 * keys are forgotten. The stamp waits for the session, a round trip of its own, because it is asked
 * for the account the session names: refused if another sign-in has replaced the cookie since, and
 * a stamp that could not be read resumes nothing but forgets nothing either.
 */
export const resumeSession = async ({
  api = vaultApi,
  idbFactory,
}: {
  readonly api?: VaultApiClient;
  readonly idbFactory?: IDBFactory;
} = {}): Promise<UnlockedVaultSession | null> => {
  const user = (await getSession())?.data?.user;
  if (!user) return null;

  const [stamp, keys] = await Promise.all([
    api
      .forAccount(user.id)
      .getUnlockStatus()
      .then(vaultStamp, () => null),
    loadUnlockKeys(user.id, idbFactory),
  ]);
  if (stamp === null || keys === null) return null;

  if (stamp !== keys.stamp) {
    await forgetUnlockKeys(user.id, idbFactory);
    return null;
  }

  const vault = await openVault({ encKey: keys.encKey }, keys.wrappedDek);
  const store = await createRecordStore({
    userId: user.id,
    rawVault: vault,
    api: api.forAccount(user.id),
    idbFactory,
  });
  return { ...keys, email: user.email, vault, store };
};

export const resetVaultAccount = async (
  userId: string,
  api: VaultApiClient = vaultApi,
): Promise<void> => {
  await api.forAccount(userId).resetVault();
};
