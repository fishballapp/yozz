import type { UnlockStatusResponse } from '@yozz.app/vault-contract';

export class VaultAlreadyExistsError extends Error {
  constructor() {
    super('A vault already exists for this account');
    this.name = 'VaultAlreadyExistsError';
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialNotFoundError';
  }
}

export const getUnlockStatus = async (
  db: D1Database,
  userId: string,
): Promise<UnlockStatusResponse> => {
  const account = await db
    .prepare(
      'SELECT unlock_mode, password_wrapped_dek, updated_at FROM vault_account WHERE user_id = ?',
    )
    .bind(userId)
    .first<{
      unlock_mode: 'password' | 'passkey';
      password_wrapped_dek: string | null;
      updated_at: number;
    }>();

  if (!account) {
    return { mode: null };
  }

  if (account.unlock_mode === 'password') {
    if (!account.password_wrapped_dek) {
      return { mode: null };
    }
    return {
      mode: 'password',
      wrappedDek: account.password_wrapped_dek,
      updatedAt: account.updated_at,
    };
  }

  const passkeysResult = await db
    .prepare(
      'SELECT passkey_id, created_at FROM vault_passkey_wrap WHERE user_id = ? ORDER BY created_at ASC',
    )
    .bind(userId)
    .all<{
      passkey_id: string;
      created_at: number;
    }>();

  return {
    mode: 'passkey',
    passkeys: passkeysResult.results.map(row => ({
      passkeyId: row.passkey_id,
      createdAt: row.created_at,
    })),
  };
};

/** By the WebAuthn credential id, which is all an authenticator response carries; `passkey.id` is Better Auth's row id. */
export const getPasskeyWrap = async (
  db: D1Database,
  userId: string,
  credentialId: string,
): Promise<string | null> => {
  const wrap = await db
    .prepare(
      `SELECT w.wrapped_dek FROM vault_passkey_wrap w
       JOIN passkey p ON p.id = w.passkey_id AND p.userId = w.user_id
       WHERE w.user_id = ? AND p.credentialID = ?`,
    )
    .bind(userId, credentialId)
    .first<{ wrapped_dek: string }>();

  return wrap?.wrapped_dek ?? null;
};

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/.test(err.message);

/** One transaction: a new vault INSERTs and lets the primary key refuse a second creator; a rewrap upserts. */
const finalize = async (db: D1Database, statements: D1PreparedStatement[]): Promise<void> => {
  try {
    await db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw new VaultAlreadyExistsError();
    throw err;
  }
};

export const finalizePasswordUnlock = async (
  db: D1Database,
  userId: string,
  { isNewVault, wrappedDek, now }: { isNewVault: boolean; wrappedDek: string; now: number },
): Promise<void> =>
  finalize(db, [
    db
      .prepare(
        `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
         VALUES (?, 'password', ?, ?, ?)
         ${
           isNewVault
             ? ''
             : `ON CONFLICT(user_id) DO UPDATE SET
                  unlock_mode = 'password',
                  password_wrapped_dek = excluded.password_wrapped_dek,
                  updated_at = excluded.updated_at`
}`,
      )
      .bind(userId, wrappedDek, now, now),
    db.prepare('DELETE FROM vault_passkey_wrap WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM passkey WHERE userId = ?').bind(userId),
  ]);

export const finalizePasskeyUnlock = async (
  db: D1Database,
  userId: string,
  {
    isNewVault,
    credentialId,
    wrappedDek,
    now,
  }: { isNewVault: boolean; credentialId: string; wrappedDek: string; now: number },
): Promise<void> => {
  const passkey = await db
    .prepare('SELECT id FROM passkey WHERE userId = ? AND credentialID = ?')
    .bind(userId, credentialId)
    .first<{ id: string }>();

  if (!passkey) {
    throw new CredentialNotFoundError('Passkey not found for user');
  }

  await finalize(db, [
    db
      .prepare(
        `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
         VALUES (?, 'passkey', NULL, ?, ?)
         ${
           isNewVault
             ? ''
             : `ON CONFLICT(user_id) DO UPDATE SET
                  unlock_mode = 'passkey',
                  password_wrapped_dek = NULL,
                  updated_at = excluded.updated_at`
}`,
      )
      .bind(userId, now, now),
    db
      .prepare(
        `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, passkey_id) DO UPDATE SET
           wrapped_dek = excluded.wrapped_dek,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, passkey.id, wrappedDek, now, now),
    db.prepare("DELETE FROM account WHERE userId = ? AND providerId = 'credential'").bind(userId),
  ]);
};

export const resetVault = async (db: D1Database, userId: string): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM vault_record WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_passkey_wrap WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_account WHERE user_id = ?').bind(userId),
    db.prepare("DELETE FROM account WHERE userId = ? AND providerId = 'credential'").bind(userId),
    db.prepare('DELETE FROM passkey WHERE userId = ?').bind(userId),
  ]);
};

/** By the ROW id, which is what the delete endpoint addresses. */
export const isPasskeyWrapped = async (
  db: D1Database,
  userId: string,
  passkeyId: string,
): Promise<boolean> => {
  const row = await db
    .prepare('SELECT 1 FROM vault_passkey_wrap WHERE user_id = ? AND passkey_id = ?')
    .bind(userId, passkeyId)
    .first<{ 1: number }>();

  return row !== null;
};
