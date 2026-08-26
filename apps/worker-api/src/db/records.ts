import type { VaultRecordEnvelope } from '@yozz.app/vault-contract';

export class RecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordConflictError';
  }
}

export const getRecord = async (
  db: D1Database,
  userId: string,
  type: string,
  id: string,
): Promise<VaultRecordEnvelope | null> => {
  const row = await db
    .prepare(
      'SELECT id, type, ciphertext, updated_at FROM vault_record WHERE user_id = ? AND type = ? AND id = ?',
    )
    .bind(userId, type, id)
    .first<{
      id: string;
      type: string;
      ciphertext: string;
      updated_at: number;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at,
  };
};

export const listRecords = async (
  db: D1Database,
  userId: string,
  type: string,
  after?: string,
  limit = 50,
): Promise<{ records: VaultRecordEnvelope[]; nextCursor: string | null }> => {
  const query = after
    ? db
        .prepare(
          'SELECT id, type, ciphertext, updated_at FROM vault_record WHERE user_id = ? AND type = ? AND id > ? ORDER BY id ASC LIMIT ?',
        )
        .bind(userId, type, after, limit + 1)
    : db
        .prepare(
          'SELECT id, type, ciphertext, updated_at FROM vault_record WHERE user_id = ? AND type = ? ORDER BY id ASC LIMIT ?',
        )
        .bind(userId, type, limit + 1);

  const result = await query.all<{
    id: string;
    type: string;
    ciphertext: string;
    updated_at: number;
  }>();

  const rows = result.results;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const records = pageRows.map(r => ({
    id: r.id,
    type: r.type,
    ciphertext: r.ciphertext,
    updatedAt: r.updated_at,
  }));
  const nextCursor =
    hasMore && pageRows.length > 0 ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

  return { records, nextCursor };
};

export const putRecord = async (
  db: D1Database,
  userId: string,
  type: string,
  id: string,
  ciphertext: string,
  now: number,
): Promise<void> => {
  /**
   * ONE statement, and the conflict is read off its result rather than from a
   * SELECT before it. The earlier version pre-checked the stored type and then
   * wrote with a `WHERE vault_record.type = excluded.type` guard: correct in
   * isolation, but the two are not atomic, so a concurrent PUT could land
   * between them, the guarded UPDATE would match nothing, and the route still
   * answered 200 while the first writer's ciphertext stayed put — a silent
   * lost write reported as success.
   *
   * The guard alone is authoritative. `changes === 0` means the row exists and
   * its type is not this one, because every other path either inserts or
   * updates exactly one row. The blind id already commits to a type, so this is
   * a client bug rather than a race to resolve.
   */
  const result = await db
    .prepare(
      `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at
       WHERE vault_record.type = excluded.type`,
    )
    .bind(userId, id, type, ciphertext, now)
    .run();

  if (result.meta.changes === 0) {
    // No id, no stored type, no requested type: an error body is a channel, and
    // a blind id echoed back into one is a blind id the caller did not have to
    // already know.
    throw new RecordConflictError('Record already exists under a different type');
  }
};

export const deleteRecord = async (
  db: D1Database,
  userId: string,
  type: string,
  id: string,
): Promise<void> => {
  await db
    .prepare('DELETE FROM vault_record WHERE user_id = ? AND type = ? AND id = ?')
    .bind(userId, type, id)
    .run();
};
