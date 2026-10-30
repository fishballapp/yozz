import { VaultApiError } from '@yozz.app/mail/vault/api';
import { deriveApprovalKeys, pairingCode, rewrapDek, sealCliLogin } from '@yozz.app/vault';
import {
  type CliApproveQuery,
  CliApproveQuerySchema,
  type CliKeySummary,
  type CliLoginCallback,
} from '@yozz.app/vault-contract';
import { type VaultApiClient, vaultApi } from './api';
import { type SessionEnded, UnlockError, type UnlockedVaultSession } from './unlock';

/**
 * The approve link's query, read from the raw search string rather than the router's parse, which
 * turns a name like `1234` into a number. `null` for a link `yozz login` did not make.
 */
export const parseCliApproveQuery = (search: string): CliApproveQuery | null => {
  const parsed = CliApproveQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(search)));
  return parsed.success ? parsed.data : null;
};

/** The CLI's one-shot listener. Always the loopback address: the port is the only part a link names. */
export const cliCallbackUrl = (port: number, callback: CliLoginCallback): string =>
  `http://127.0.0.1:${port}/callback?${new URLSearchParams(callback)}`;

/**
 * Wraps the DEK to the CLI's key, mints its bearer and seals the login to it, so the callback URL the
 * browser's history keeps opens for that CLI and that login only. Needs a fresh session.
 */
export const approveCliLogin = async ({
  session,
  query: { port, state, publicKey, name },
  isCurrent,
  api = vaultApi,
}: {
  readonly session: UnlockedVaultSession;
  readonly query: CliApproveQuery;
  readonly isCurrent: () => boolean;
  readonly api?: VaultApiClient;
}): Promise<{ readonly outcome: 'approved'; readonly callbackUrl: string } | SessionEnded> => {
  const { userId, email } = session;
  const keys = await deriveApprovalKeys(publicKey);
  const wrappedDek = await rewrapDek(session, keys, session.wrappedDek);
  if (!isCurrent()) return { outcome: 'ended' };

  const { token } = await api
    .forAccount(userId)
    .createCliKey({ name, publicKey, ephemeralPublicKey: keys.ephemeralPublicKey, wrappedDek })
    .catch((error: unknown) => {
      if (error instanceof VaultApiError && error.code === 'CONFLICT') {
        throw new UnlockError('This account has no vault to open. Reload the page and try again.');
      }
      throw error;
    });
  // Past this point the key exists, so the CLI gets it even if the tab locked meanwhile: the person
  // asked for it, and it is listed in Settings to revoke.
  const sealedLogin = await sealCliLogin(keys.tokenKey, {
    state,
    payload: { token, userId, email },
  });
  return {
    outcome: 'approved',
    callbackUrl: cliCallbackUrl(port, {
      state,
      ephemeralPublicKey: keys.ephemeralPublicKey,
      sealedLogin,
    }),
  };
};

/** One of this account's CLI keys, as Settings lists it. */
export type AccountCliKey = CliKeySummary & {
  /** What the terminal showed when it was approved. */
  readonly pairingCode: string;
};

/** Oldest first, as the Worker lists them and as the passkeys read. */
export const listCliKeys = async (
  userId: string,
  api: VaultApiClient = vaultApi,
): Promise<readonly AccountCliKey[]> => {
  const keys = await api.forAccount(userId).listCliKeys();
  return Promise.all(
    keys.map(async key => ({ ...key, pairingCode: await pairingCode(key.publicKey) })),
  );
};

/** Needs a fresh session. A key already gone is refused, so the list can be read again. */
export const revokeCliKey = async ({
  userId,
  keyId,
  api = vaultApi,
}: {
  readonly userId: string;
  readonly keyId: string;
  readonly api?: VaultApiClient;
}): Promise<void> => {
  try {
    await api.forAccount(userId).revokeCliKey(keyId);
  } catch (error) {
    if (error instanceof VaultApiError && error.code === 'NOT_FOUND') {
      throw new UnlockError('That key is already revoked.');
    }
    throw error;
  }
};
