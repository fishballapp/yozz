import type { VaultRecordEnvelope } from '@yozz.app/vault-contract';

export class RecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordConflictError';
  }
}

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

/** `'create'`: no row yet. `{ ifRevision: null }`: the row predates the column. Absent: last write wins. */
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
    // One statement: the type guard is the conflict check, since a SELECT before the write would not be atomic with it.
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
      // The message names no id or type: an error body is a channel.
      throw new RecordConflictError('Record already exists under a different type');
    }
    return;
  }

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

  // `revision IS ?` so that `null` (a row predating the column) matches; `= NULL` matches nothing.
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
  if (result.meta.changes === 0) throw new RecordStaleError();
};
