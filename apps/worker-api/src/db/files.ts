import { MAX_STORED_BYTES_PER_USER, type VaultFileSummary } from '@yozz.app/vault-contract';

/** The trailing slash in the prefix is what keeps one user's listing out of another's. */
const objectPrefix = (userId: string): string => `${userId}/`;

export const fileObjectKey = (userId: string, fileId: string): string =>
  `${objectPrefix(userId)}${fileId}`;

/**
 * The row before the bytes, in one statement: the sum and the insert cannot be split by another
 * upload, so two uploads cannot both fit in the room for one.
 */
export const reserveFile = async (
  db: D1Database,
  { userId, fileId, size, now }: { userId: string; fileId: string; size: number; now: number },
): Promise<'reserved' | 'exists' | 'full'> => {
  const inserted = await db
    .prepare(
      `INSERT INTO vault_file (user_id, file_id, size, created_at)
       SELECT ?, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(size), 0) FROM vault_file WHERE user_id = ?) + ? <= ?
       ON CONFLICT (user_id, file_id) DO NOTHING`,
    )
    .bind(userId, fileId, size, now, userId, size, MAX_STORED_BYTES_PER_USER)
    .run();
  if (inserted.meta.changes === 1) return 'reserved';

  const existing = await db
    .prepare('SELECT 1 FROM vault_file WHERE user_id = ? AND file_id = ?')
    .bind(userId, fileId)
    .first();
  return existing === null ? 'full' : 'exists';
};

export const releaseFile = async (
  db: D1Database,
  userId: string,
  fileId: string,
): Promise<void> => {
  await db
    .prepare('DELETE FROM vault_file WHERE user_id = ? AND file_id = ?')
    .bind(userId, fileId)
    .run();
};

/**
 * Throws unless the object is exactly what its row counts, and the row still stands. R2 takes a
 * request body only when its length is known, and a connection that drops part way rejects the
 * `put`. The caller's `removeFile` clears up after any throw.
 */
export const storeFileObject = async (
  bucket: R2Bucket,
  db: D1Database,
  {
    userId,
    fileId,
    body,
    size,
  }: { userId: string; fileId: string; body: ReadableStream; size: number },
): Promise<void> => {
  const object = await bucket.put(fileObjectKey(userId, fileId), body);
  if (object?.size !== size) {
    throw new Error(`Stored ${object?.size} bytes where ${size} were reserved`);
  }
  // Size too: a delete and a new upload under this id can leave a smaller row in this one's place.
  const row = await db
    .prepare('SELECT size FROM vault_file WHERE user_id = ? AND file_id = ?')
    .bind(userId, fileId)
    .first<{ size: number }>();
  if (row?.size !== size) throw new Error('The reservation went while the file was uploading');
};

export const removeFile = async (
  bucket: R2Bucket,
  db: D1Database,
  userId: string,
  fileId: string,
): Promise<void> => {
  const key = fileObjectKey(userId, fileId);
  // A failure here leaves the row, so a retry still finds the file.
  await bucket.delete(key);
  await releaseFile(db, userId, fileId);
  // A `put` landing before the release passed its row check, so only this catches it; a later one sees no row.
  await bucket.delete(key);
};

export const listFiles = async (
  db: D1Database,
  userId: string,
  after?: string,
  limit = 100,
): Promise<{
  files: VaultFileSummary[];
  nextCursor: string | null;
  usedBytes: number;
}> => {
  const [page, usage] = await db.batch<{
    file_id: string;
    size: number;
    created_at: number;
    used_bytes: number;
  }>([
    db
      .prepare(
        `SELECT file_id, size, created_at FROM vault_file
          WHERE user_id = ? AND file_id > ? ORDER BY file_id ASC LIMIT ?`,
      )
      .bind(userId, after ?? '', limit + 1),
    db
      .prepare('SELECT COALESCE(SUM(size), 0) AS used_bytes FROM vault_file WHERE user_id = ?')
      .bind(userId),
  ]);
  const rows = page?.results ?? [];
  const pageRows = rows.slice(0, limit);
  return {
    files: pageRows.map(row => ({ id: row.file_id, size: row.size, createdAt: row.created_at })),
    nextCursor: rows.length > limit ? (pageRows.at(-1)?.file_id ?? null) : null,
    usedBytes: usage?.results[0]?.used_bytes ?? 0,
  };
};

/**
 * Every object under the user, found in the bucket rather than through the rows, so an object whose
 * row is gone goes too. A page is at most the 1000 keys `delete` takes, and R2 can answer one that is
 * short or empty with more to come, so `truncated` is what ends the walk.
 */
export const deleteAllFileObjects = async (bucket: R2Bucket, userId: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: objectPrefix(userId),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.objects.length > 0) await bucket.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};
