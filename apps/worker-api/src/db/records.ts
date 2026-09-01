import type { VaultRecordEnvelope } from '@yozz.app/vault-contract';

export class RecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordConflictError';
  }
}

/** The stated precondition did not hold: the row moved on, and nothing was written. */
export class RecordStaleError extends Error {
  constructor() {
    super('Record revision is stale');
    this.name = 'RecordStaleError';
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
      'SELECT id, type, ciphertext, updated_at, revision FROM vault_record WHERE user_id = ? AND type = ? AND id = ?',
    )
    .bind(userId, type, id)
    .first<{
      id: string;
      type: string;
      ciphertext: string;
      updated_at: number;
      revision: number | null;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at,
    revision: row.revision,
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
          'SELECT id, type, ciphertext, updated_at, revision FROM vault_record WHERE user_id = ? AND type = ? AND id > ? ORDER BY id ASC LIMIT ?',
        )
        .bind(userId, type, after, limit + 1)
    : db
        .prepare(
          'SELECT id, type, ciphertext, updated_at, revision FROM vault_record WHERE user_id = ? AND type = ? ORDER BY id ASC LIMIT ?',
        )
        .bind(userId, type, limit + 1);

  const result = await query.all<{
    id: string;
    type: string;
    ciphertext: string;
    updated_at: number;
    revision: number | null;
  }>();

  const rows = result.results;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const records = pageRows.map(r => ({
    id: r.id,
    type: r.type,
    ciphertext: r.ciphertext,
    updatedAt: r.updated_at,
    revision: r.revision,
  }));
  const nextCursor =
    hasMore && pageRows.length > 0 ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

  return { records, nextCursor };
};

/**
 * What a write claims about the row it is replacing. Absent is the pre-CAS behaviour every
 * existing caller keeps: last write wins, the revision column simply follows along.
 * - `'create'` — there is no row yet.
 * - `{ ifRevision: n }` — the row is at exactly `n`.
 * - `{ ifRevision: null }` — the row predates the column.
 */
export type PutPrecondition = 'create' | { readonly ifRevision: number | null };

export const putRecord = async (
  db: D1Database,
  userId: string,
  type: string,
  id: string,
  ciphertext: string,
  revision: number,
  now: number,
  precondition?: PutPrecondition,
): Promise<void> => {
  if (precondition === undefined) {
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
        `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at,
           revision = excluded.revision
         WHERE vault_record.type = excluded.type`,
      )
      .bind(userId, id, type, ciphertext, now, revision)
      .run();

    if (result.meta.changes === 0) {
      // No id, no stored type, no requested type: an error body is a channel, and
      // a blind id echoed back into one is a blind id the caller did not have to
      // already know.
      throw new RecordConflictError('Record already exists under a different type');
    }
    return;
  }

  // Create: the INSERT itself is the precondition, so a row that already exists is the refusal.
  if (precondition === 'create') {
    const created = await db
      .prepare(
        `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO NOTHING`,
      )
      .bind(userId, id, type, ciphertext, now, revision)
      .run();
    if (created.meta.changes === 0) throw new RecordStaleError();
    return;
  }

  /**
   * Update. `revision IS ?` rather than `= ?` so the pre-CAS case (`null`) is the same statement:
   * SQLite's `IS` compares NULLs as equal, and `= NULL` would match nothing and read as a stale
   * write. The type guard rides along, so a mismatched type is refused here as well — as a stale
   * write rather than a conflict, which is honest: the caller stated a precondition about a row
   * it does not actually own.
   */
  const updated = await db
    .prepare(
      `UPDATE vault_record
          SET ciphertext = ?, updated_at = ?, revision = ?
        WHERE user_id = ? AND id = ? AND type = ? AND revision IS ?`,
    )
    .bind(ciphertext, now, revision, userId, id, type, precondition.ifRevision)
    .run();
  if (updated.meta.changes === 0) throw new RecordStaleError();
};

export const deleteRecord = async (
  db: D1Database,
  userId: string,
  type: string,
  id: string,
  /** Stated: delete only this exact revision. Omitted: delete whatever is there, as before. */
  ifRevision?: number,
): Promise<void> => {
  if (ifRevision === undefined) {
    await db
      .prepare('DELETE FROM vault_record WHERE user_id = ? AND type = ? AND id = ?')
      .bind(userId, type, id)
      .run();
    return;
  }
  const result = await db
    .prepare('DELETE FROM vault_record WHERE user_id = ? AND type = ? AND id = ? AND revision IS ?')
    .bind(userId, type, id, ifRevision)
    .run();
  // An unconditional delete is idempotent, but a stated one is a claim about what is there: a
  // row that moved on must not be reported as deleted.
  if (result.meta.changes === 0) throw new RecordStaleError();
};
