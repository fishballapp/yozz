import type { CliKeySummary, CliKeyWrapResponse } from '@yozz.app/vault-contract';
import { SESSION_EXISTS } from './unlock.ts';

/**
 * A key is minted only for a session that is still there and a vault that exists, read in the same
 * statement as the insert: a session signed out while the request was in flight (a password change
 * elsewhere signs every other session out) plants nothing, and neither does one racing a reset.
 */
export const createCliKey = async (
  db: D1Database,
  userId: string,
  {
    keyId,
    name,
    publicKey,
    ephemeralPublicKey,
    wrappedDek,
    tokenHash,
    sessionId,
    now,
  }: {
    keyId: string;
    name: string;
    publicKey: string;
    ephemeralPublicKey: string;
    wrappedDek: string;
    tokenHash: string;
    sessionId: string;
    now: number;
  },
): Promise<boolean> => {
  const result = await db
    .prepare(
      `INSERT INTO vault_cli_key
         (id, user_id, name, public_key, ephemeral_public_key, wrapped_dek, token_hash, created_at, last_used_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE ${SESSION_EXISTS}
         AND EXISTS (SELECT 1 FROM vault_account WHERE user_id = ?)`,
    )
    .bind(
      keyId,
      userId,
      name,
      publicKey,
      ephemeralPublicKey,
      wrappedDek,
      tokenHash,
      now,
      sessionId,
      userId,
      userId,
    )
    .run();
  return result.meta.changes === 1;
};

export const listCliKeys = async (db: D1Database, userId: string): Promise<CliKeySummary[]> => {
  const { results } = await db
    .prepare(
      `SELECT id, name, public_key, created_at, last_used_at FROM vault_cli_key
       WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      public_key: string;
      created_at: number;
      last_used_at: number | null;
    }>();
  return results.map(row => ({
    keyId: row.id,
    name: row.name,
    publicKey: row.public_key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
};

/** What a bearer is checked against. */
export const findCliKey = async (
  db: D1Database,
  keyId: string,
): Promise<{ readonly userId: string; readonly tokenHash: string } | null> => {
  const row = await db
    .prepare('SELECT user_id, token_hash FROM vault_cli_key WHERE id = ?')
    .bind(keyId)
    .first<{ user_id: string; token_hash: string }>();
  return row === null ? null : { userId: row.user_id, tokenHash: row.token_hash };
};

/** The key's wrap of the DEK, stamping it used in the same statement. */
export const useCliKey = async (
  db: D1Database,
  userId: string,
  { keyId, now }: { keyId: string; now: number },
): Promise<CliKeyWrapResponse | null> => {
  const row = await db
    .prepare(
      `UPDATE vault_cli_key SET last_used_at = ? WHERE id = ? AND user_id = ?
       RETURNING id, ephemeral_public_key, wrapped_dek`,
    )
    .bind(now, keyId, userId)
    .first<{ id: string; ephemeral_public_key: string; wrapped_dek: string }>();
  return row === null
    ? null
    : { keyId: row.id, ephemeralPublicKey: row.ephemeral_public_key, wrappedDek: row.wrapped_dek };
};

export const deleteCliKey = async (
  db: D1Database,
  userId: string,
  keyId: string,
): Promise<boolean> => {
  const result = await db
    .prepare('DELETE FROM vault_cli_key WHERE id = ? AND user_id = ?')
    .bind(keyId, userId)
    .run();
  return result.meta.changes === 1;
};
