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
const finalize = async (db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> => {
  try {
    return await db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw new VaultAlreadyExistsError();
    throw err;
  }
};

/** Whether the session row a request carried is still there: a password change or a sign-out deletes it. */
export const sessionExists = async (
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<boolean> =>
  (await db
    .prepare('SELECT 1 AS found FROM session WHERE id = ? AND userId = ?')
    .bind(sessionId, userId)
    .first()) !== null;

export const SESSION_EXISTS = 'EXISTS (SELECT 1 FROM session WHERE id = ? AND userId = ?)';

/**
 * The credential row is written with the vault row, so a failure leaves neither: a half-done switch
 * would lock the person out of their data. The hash was made between the caller's checks and this
 * batch, so another switch, or a password change that signed this session out, may have got there
 * first. Every statement therefore carries the same guard on the state it expects, the caller's
 * session row still there and the vault still as it was (a passkey vault being rewrapped, or none
 * yet), and the vault row is written last, so nothing before it can change what the guard reads:
 * all of it applies or none of it does (`false`), which is what stops a switch from replacing a
 * password it never knew. The guard reads server state only. A marker the client sends, such as the
 * wrapped DEK it can read back from `GET /unlock`, would let it vouch for a batch that wrote nothing.
 */
export const finalizePasswordUnlock = async (
  db: D1Database,
  userId: string,
  {
    isNewVault,
    wrappedDek,
    passwordHash,
    sessionId,
    now,
  }: {
    isNewVault: boolean;
    wrappedDek: string;
    passwordHash: string;
    sessionId: string;
    now: number;
  },
): Promise<boolean> => {
  const guard = `${SESSION_EXISTS} AND ${
    isNewVault
      ? 'NOT EXISTS (SELECT 1 FROM vault_account WHERE user_id = ?)'
      : "EXISTS (SELECT 1 FROM vault_account WHERE user_id = ? AND unlock_mode = 'passkey')"
  }`;
  const expected = [sessionId, userId, userId];
  const results = await finalize(db, [
    db
      .prepare(`DELETE FROM vault_passkey_wrap WHERE user_id = ? AND ${guard}`)
      .bind(userId, ...expected),
    db.prepare(`DELETE FROM passkey WHERE userId = ? AND ${guard}`).bind(userId, ...expected),
    db
      .prepare(`DELETE FROM account WHERE userId = ? AND providerId = 'credential' AND ${guard}`)
      .bind(userId, ...expected),
    // The row Better Auth's own `setPassword` links: dates are ISO strings, the account id is the user's.
    db
      .prepare(
        `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
         SELECT ?, ?, 'credential', ?, ?, ?, ? WHERE ${guard}`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        userId,
        passwordHash,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        ...expected,
      ),
    isNewVault
      ? db
          .prepare(
            `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
             SELECT ?, 'password', ?, ?, ? WHERE ${guard}`,
          )
          .bind(userId, wrappedDek, now, now, ...expected)
      : db
          .prepare(
            `UPDATE vault_account SET unlock_mode = 'password', password_wrapped_dek = ?, updated_at = ?
             WHERE user_id = ? AND ${guard}`,
          )
          .bind(wrappedDek, now, userId, ...expected),
  ]);
  return results[4]?.meta.changes === 1;
};

/** What `signIn.email` compares an `authValue` with; absent for an account in passkey mode. */
export const getPasswordHash = async (db: D1Database, userId: string): Promise<string | null> => {
  const row = await db
    .prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'")
    .bind(userId)
    .first<{ password: string | null }>();
  return row?.password ?? null;
};

/**
 * A password-mode account's new credential and its DEK rewrapped under it, in one batch: a hash
 * that changed while the wrap did not would lock the person out of their data for good. Both
 * writes, and the sign-out of every other session and every CLI key, hold only while the hash is
 * still the one the caller verified, so a change that lost a race to another applies nothing and says so (`false`).
 */
export const changePasswordUnlock = async (
  db: D1Database,
  userId: string,
  {
    currentHash,
    newHash,
    wrappedDek,
    keepSessionId,
    now,
  }: {
    currentHash: string;
    newHash: string;
    wrappedDek: string;
    keepSessionId: string;
    now: number;
  },
): Promise<boolean> => {
  const results = await db.batch([
    // Before the credential moves, while `currentHash` is still what the condition reads.
    db
      .prepare(
        `UPDATE vault_account SET password_wrapped_dek = ?, updated_at = ?
         WHERE user_id = ? AND unlock_mode = 'password' AND ${SESSION_EXISTS}
           AND EXISTS (SELECT 1 FROM account
                       WHERE userId = ? AND providerId = 'credential' AND password = ?)`,
      )
      .bind(wrappedDek, now, userId, keepSessionId, userId, userId, currentHash),
    db
      .prepare(
        `UPDATE account SET password = ?, updatedAt = ?
         WHERE userId = ? AND providerId = 'credential' AND password = ? AND ${SESSION_EXISTS}`,
      )
      .bind(newHash, new Date(now).toISOString(), userId, currentHash, keepSessionId, userId),
    // A salted hash equals `newHash` only if the statement above wrote it.
    db
      .prepare(
        `DELETE FROM session
         WHERE userId = ? AND id <> ?
           AND EXISTS (SELECT 1 FROM account
                       WHERE userId = ? AND providerId = 'credential' AND password = ?)`,
      )
      .bind(userId, keepSessionId, userId, newHash),
    // Signing the others out evicts their CLI keys too: one minted by an intruder's session would
    // otherwise keep its bearer on the records.
    db
      .prepare(
        `DELETE FROM vault_cli_key
         WHERE user_id = ?
           AND EXISTS (SELECT 1 FROM account
                       WHERE userId = ? AND providerId = 'credential' AND password = ?)`,
      )
      .bind(userId, userId, newHash),
  ]);
  return results[1]?.meta.changes === 1;
};

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

/** Every way into the vault goes with it, CLI keys included: their wraps are of a DEK that no longer exists. */
export const resetVault = async (db: D1Database, userId: string): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM vault_record WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_cli_key WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_passkey_wrap WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_account WHERE user_id = ?').bind(userId),
    db.prepare("DELETE FROM account WHERE userId = ? AND providerId = 'credential'").bind(userId),
    db.prepare('DELETE FROM passkey WHERE userId = ?').bind(userId),
  ]);
};

/**
 * A passkey and its wrap of the DEK, deleted together, never the last one that can sign in. Every
 * statement carries the same guard, read from server state the client cannot write: the caller's
 * session row is still there, the credential is this user's, and another passkey of theirs still
 * has a wrap (one without a wrap cannot sign in, so it does not count as left). The passkey row goes
 * last, so every statement reads the same rows; the other sessions and every CLI key go with it, never on a guess:
 * the guard is what proves the removal applies. Two removals racing
 * on the last two passkeys run one after the other, and the second finds one left and applies
 * nothing (`false`).
 */
export const removePasskeyUnlock = async (
  db: D1Database,
  userId: string,
  { credentialId, sessionId }: { credentialId: string; sessionId: string },
): Promise<boolean> => {
  const guard = `${SESSION_EXISTS}
    AND EXISTS (SELECT 1 FROM passkey WHERE userId = ? AND credentialID = ?)
    AND EXISTS (SELECT 1 FROM vault_passkey_wrap w
                JOIN passkey p ON p.id = w.passkey_id AND p.userId = w.user_id
                WHERE w.user_id = ? AND p.credentialID <> ?)`;
  const expected = [sessionId, userId, userId, credentialId, userId, credentialId];
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM vault_passkey_wrap
         WHERE user_id = ? AND passkey_id = (SELECT id FROM passkey WHERE userId = ? AND credentialID = ?)
           AND ${guard}`,
      )
      .bind(userId, userId, credentialId, ...expected),
    // Whoever held the removed passkey, a lost laptop included, is signed out; the caller is not.
    db
      .prepare(`DELETE FROM session WHERE userId = ? AND id <> ? AND ${guard}`)
      .bind(userId, sessionId, ...expected),
    // And every CLI key, which an intruder's session may have minted.
    db
      .prepare(`DELETE FROM vault_cli_key WHERE user_id = ? AND ${guard}`)
      .bind(userId, ...expected),
    db
      .prepare(`DELETE FROM passkey WHERE userId = ? AND credentialID = ? AND ${guard}`)
      .bind(userId, credentialId, ...expected),
  ]);
  return results[3]?.meta.changes === 1;
};

/** Whether the passkey is this user's, by the WebAuthn credential id the remove route is given. */
export const hasPasskey = async (
  db: D1Database,
  userId: string,
  credentialId: string,
): Promise<boolean> =>
  (await db
    .prepare('SELECT 1 AS found FROM passkey WHERE userId = ? AND credentialID = ?')
    .bind(userId, credentialId)
    .first()) !== null;

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
