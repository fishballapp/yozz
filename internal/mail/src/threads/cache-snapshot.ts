import type { ImapMessageSummary } from '@yozz.app/imap';
import { z } from 'zod';
import { VaultApiError } from '../vault/api.ts';
import type { FileStore } from '../vault/file-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import type { FolderSync, MailCache } from './cache.ts';
import { FOLDERS, type Folder } from './thread.ts';

/**
 * A copy of one mailbox's list in the vault, so a device with no cache for it shows the list at once
 * and syncs on from there instead of from nothing, and one whose cache is older shows the newer
 * list. Each folder's sync mark and summaries, no bodies. The list is too big for a record, so it
 * is a vault file of JSON, named by a small record per mailbox; a file is never replaced, so each
 * write is a new file and a compare-and-swap of the record. All of it is derived: a snapshot lost,
 * stale, refused or unreadable costs only the speed-up.
 */
export const CACHE_SNAPSHOT_RECORD_TYPE = 'cache-snapshot';

/** How often a mailbox's snapshot is written at most, by this device or any other. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** The mailbox a snapshot is of: another host or login may be another mailbox, whose uids say nothing about this one's. */
type SnapshotMailbox = {
  readonly address: string;
  readonly imap: { readonly host: string; readonly username: string };
};

/** The plaintext of a `cache-snapshot` record. The natural key is the address, as an `address` record's is. */
const snapshotRecordSchema = z.object({
  fileId: z.uuid(),
  host: z.string(),
  username: z.string(),
  writtenAt: z.number().int().nonnegative(),
  /** SHA-256 of the snapshot's JSON, so an unchanged list is not written again. */
  digest: z.string(),
});
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;

/** Total: a record this build cannot read is skipped. */
export const parseSnapshotRecord = (plaintext: string): SnapshotRecord | null => {
  try {
    const result = snapshotRecordSchema.safeParse(JSON.parse(plaintext) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/** The snapshot records by address. */
export type SnapshotRecords = ReadonlyMap<string, SnapshotRecord>;

/**
 * Every mailbox's snapshot record in one request, so an open costs one round trip however many
 * mailboxes it restores. Total: a list that fails names none, and the device shows what it has.
 */
export const listSnapshotRecords = async (store: RecordStore): Promise<SnapshotRecords> => {
  try {
    const rows = await store.list(CACHE_SNAPSHOT_RECORD_TYPE);
    return new Map(
      rows.flatMap(({ naturalKey, plaintext }) => {
        const record = parseSnapshotRecord(plaintext);
        return record === null ? [] : [[naturalKey, record] as const];
      }),
    );
  } catch {
    return new Map();
  }
};

const isOf = (record: SnapshotRecord, { imap }: SnapshotMailbox) =>
  record.host === imap.host && record.username === imap.username;

const nullableString = z.string().nullable();
const imapAddressSchema = z.object({
  name: nullableString,
  mailbox: nullableString,
  host: nullableString,
});
const summarySchema = z.object({
  seq: z.number().int(),
  uid: z.number().int().positive(),
  flags: z.array(z.string()),
  internalDate: nullableString,
  size: z.number().int().nullable(),
  envelope: z
    .object({
      date: nullableString,
      subject: nullableString,
      subjectRaw: nullableString,
      from: z.array(imapAddressSchema),
      sender: z.array(imapAddressSchema),
      replyTo: z.array(imapAddressSchema),
      to: z.array(imapAddressSchema),
      cc: z.array(imapAddressSchema),
      bcc: z.array(imapAddressSchema),
      inReplyTo: nullableString,
      messageId: nullableString,
    })
    .nullable(),
  references: z.array(z.string()),
  gmailThreadId: nullableString,
  attachmentNames: z.array(z.string()),
}) satisfies z.ZodType<ImapMessageSummary>;

const snapshotSchema = z.object({
  folders: z.array(
    z.object({
      folder: z.custom<Folder>(value => FOLDERS.some(folder => folder === value)),
      sync: z.object({
        name: z.string(),
        uidValidity: z.number().int().nonnegative(),
        lastUid: z.number().int().nonnegative(),
        complete: z.boolean(),
        hasAttachmentNames: z.boolean().optional(),
      }) satisfies z.ZodType<FolderSync>,
      summaries: z.array(summarySchema),
    }),
  ),
});
type Snapshot = {
  readonly folders: readonly {
    readonly folder: Folder;
    readonly sync: FolderSync;
    readonly summaries: readonly ImapMessageSummary[];
  }[];
};

const sha256 = async (text: string): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toHex();

/** The snapshot is for a device to show its mail at once; seeding spam would only spend vault space. */
const SNAPSHOT_FOLDERS = FOLDERS.filter(folder => folder !== 'junk');

/**
 * Each folder that has synced but Junk, its mark read before its summaries: a sync writes summaries before
 * the mark, so a summary newer than the mark is read again by the next sync, while a mark newer
 * than its summaries would leave the mail between them unread for good. Then the mark is read again:
 * a clear or a start-over meanwhile deletes summaries the first mark still claims, and a snapshot of
 * that would hide them on every device it seeds. Answers null then, and a later sync writes it.
 */
const readSnapshot = async (cache: MailCache): Promise<Snapshot | null> => {
  const folders = await Promise.all(
    SNAPSHOT_FOLDERS.map(async folder => {
      const folderCache = cache.folder(folder);
      const sync = await folderCache.getSync();
      if (sync === null) return [];
      // In uid order, so the same list has the same digest whichever store held it.
      const summaries = (await folderCache.listSummaries()).toSorted((a, b) => a.uid - b.uid);
      const after = await folderCache.getSync();
      if (JSON.stringify(after) !== JSON.stringify(sync)) return null;
      return [{ folder, sync, summaries }];
    }),
  );
  if (folders.includes(null)) return null;
  return { folders: folders.flatMap(folder => folder ?? []) };
};

/** How long a device with a list of its own waits for the vault's snapshot before showing it. */
export const SNAPSHOT_WAIT_MS = 1000;

/** What `promise` answers within `ms`, or null once they pass; a later answer is dropped. */
const within = async <T>(ms: number, promise: Promise<T>): Promise<T | null> => {
  const { promise: timedOut, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), ms);
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};

type SnapshotFolder = Snapshot['folders'][number];

/** The empty cache filled from the snapshot. Answers whether any folder was written. */
const seed = async (
  cache: MailCache,
  snapshot: Snapshot,
  isStale: () => boolean,
): Promise<boolean> => {
  // Summaries left with no mark (a seed cut short) would never be dropped by a sync.
  await cache.clear();
  for (const { folder, sync, summaries } of snapshot.folders) {
    if (isStale()) return false;
    const folderCache = cache.folder(folder);
    // Summaries before the mark, as a sync writes them; see `readSnapshot`.
    await folderCache.putSummaries(summaries);
    // A lock during that write has cleared the cache; a mark written now would claim mail it lacks.
    if (isStale()) return false;
    await folderCache.putSync(sync);
  }
  return snapshot.folders.length > 0;
};

/**
 * The folder once the snapshot's copy is laid over this device's, or null when the sync is left to
 * it: the snapshot's mark is not past this device's, or names another UIDVALIDITY, whose uids name
 * other mail. Within the snapshot's window its summaries are the list, so mail gone since goes here
 * too. Below it, older pages this device read are kept only when the window reaches down to this
 * device's mark; otherwise mail between the two is in neither copy, and a mark over it would hide it
 * for good, so the folder starts over from the snapshot as a sync starts over from a window that
 * does not reach its mark.
 */
const laidOver = (
  local: { readonly sync: FolderSync | null; readonly summaries: readonly ImapMessageSummary[] },
  { sync, summaries }: SnapshotFolder,
): { readonly kept: readonly ImapMessageSummary[]; readonly sync: FolderSync } | null => {
  if (local.sync === null) return { kept: [], sync };
  if (sync.uidValidity !== local.sync.uidValidity || sync.lastUid <= local.sync.lastUid) {
    return null;
  }
  // A copy above the snapshot's mark is one this device filed (`recordMoves`), which the next sync
  // reads again with the rest of the new mail; until then it stays where the move put it.
  const filed = local.summaries.filter(({ uid }) => uid > sync.lastUid);
  // An empty window reaches no mark.
  const lowest = Math.min(...summaries.map(({ uid }) => uid));
  const isWindowAtMark = !sync.complete && lowest <= local.sync.lastUid;
  const kept = [
    ...(isWindowAtMark ? local.summaries.filter(({ uid }) => uid < lowest) : []),
    ...filed,
  ];
  return {
    kept,
    sync: {
      ...sync,
      complete: sync.complete || (isWindowAtMark && local.sync.complete),
      // Kept pages read before summaries carried names still want their one backfill.
      hasAttachmentNames:
        sync.hasAttachmentNames === true &&
        (kept.length === 0 || local.sync.hasAttachmentNames === true),
    },
  };
};

/**
 * Each folder of the snapshot that is newer than this device's copy, laid over it (`laidOver`).
 * Bodies and previews stay: a uid under one UIDVALIDITY names one message. Answers whether any
 * folder was written.
 */
const merge = async (
  cache: MailCache,
  snapshot: Snapshot,
  isStale: () => boolean,
): Promise<boolean> => {
  let isWritten = false;
  for (const folderSnapshot of snapshot.folders) {
    if (isStale()) return false;
    const folderCache = cache.folder(folderSnapshot.folder);
    const local = {
      sync: await folderCache.getSync(),
      summaries: await folderCache.listSummaries(),
    };
    const merged = laidOver(local, folderSnapshot);
    if (merged === null) continue;
    const staying = new Set([...merged.kept, ...folderSnapshot.summaries].map(({ uid }) => uid));
    // The mark claims nothing while the summaries change under it, so a merge cut short leaves a
    // folder the next sync reads afresh, never a mark over mail the cache lacks.
    if (isStale()) return false;
    if (local.sync !== null) {
      await folderCache.putSync({ ...local.sync, lastUid: 0, complete: false });
    }
    if (isStale()) return false;
    await folderCache.deleteSummaries(
      local.summaries.filter(({ uid }) => !staying.has(uid)).map(({ uid }) => uid),
    );
    if (isStale()) return false;
    await folderCache.putSummaries(folderSnapshot.summaries);
    // As in `seed`: a lock during that write has cleared the cache.
    if (isStale()) return false;
    await folderCache.putSync(merged.sync);
    isWritten = true;
  }
  return isWritten;
};

/**
 * Brings the device's cache of the mailbox up to the vault's snapshot, if there is one of this
 * mailbox that opens. A device with no cache is filled from it; one with a cache takes each folder
 * the snapshot is newer in (`merge`), and waits for the record and the file at most `waitMs`, since
 * it has a list to show.
 * A snapshot this cache already took in or wrote is not downloaded again. Answers whether it wrote
 * anything. The sync after it takes the cache like any other, however old: a renumbered folder is
 * dropped, a gap wider than the window starts the folder over, flags are read again and mail gone
 * since is dropped.
 */
export const restoreSnapshot = async ({
  records,
  files,
  cache,
  mailbox,
  isStale = () => false,
  waitMs = SNAPSHOT_WAIT_MS,
}: {
  /** `listSnapshotRecords`, usually already in flight, so a restore adds no round trip of its own. */
  readonly records: Promise<SnapshotRecords>;
  readonly files: FileStore;
  readonly cache: MailCache;
  readonly mailbox: SnapshotMailbox;
  /** A lock or a removal meanwhile has cleared the cache, which a write now would refill. */
  readonly isStale?: () => boolean;
  readonly waitMs?: number;
}): Promise<boolean> => {
  try {
    // The device has a cache of the mailbox once any folder of it has synced.
    const hasCache = (
      await Promise.all(FOLDERS.map(folder => cache.folder(folder).getSync()))
    ).some(mark => mark !== null);
    const download = (async () => {
      const record = (await records).get(mailbox.address) ?? null;
      if (record === null || !isOf(record, mailbox)) return null;
      if (hasCache && (await cache.getSnapshotDigest()) === record.digest) return null;
      const bytes = await files.get(record.fileId);
      return bytes === null ? null : { digest: record.digest, bytes };
    })();
    const downloaded = hasCache ? await within(waitMs, download) : await download;
    if (downloaded === null) return false;
    const parsed = snapshotSchema.safeParse(
      JSON.parse(new TextDecoder().decode(downloaded.bytes)) as unknown,
    );
    if (!parsed.success || isStale()) return false;
    const isWritten = hasCache
      ? await merge(cache, parsed.data, isStale)
      : await seed(cache, parsed.data, isStale);
    if (isStale()) return false;
    await cache.putSnapshotDigest(downloaded.digest);
    return isWritten;
  } catch {
    // Unreachable, refused, or a file that does not open: the sync reads on from what is here.
    return false;
  }
};

/** What a `save` did; only tests ask. */
export type SaveOutcome = 'saved' | 'skipped' | 'failed';

/**
 * Writes a mailbox's snapshot after a sync of it landed: at most every `SNAPSHOT_INTERVAL_MS` per
 * mailbox, by this writer or any other device, and only when the list changed. Best effort: it
 * never throws, and a write that loses the compare-and-swap gives up, since either device's copy
 * serves. A full vault refuses the file and the snapshot stays as it was.
 */
export const createSnapshotWriter = ({
  store,
  files,
  now = Date.now,
}: {
  readonly store: RecordStore;
  readonly files: FileStore;
  readonly now?: () => number;
}) => {
  /** When this writer last looked at each mailbox, so a run of syncs costs one look per interval. */
  const lookedAt = new Map<string, number>();

  const save = async (
    mailbox: SnapshotMailbox,
    cache: MailCache,
    /** A lock or a removal meanwhile has cleared the cache, which a write now would refill. */
    isStale: () => boolean = () => false,
  ): Promise<SaveOutcome> => {
    const at = now();
    const before = lookedAt.get(mailbox.address);
    if (before !== undefined && at - before < SNAPSHOT_INTERVAL_MS) return 'skipped';
    lookedAt.set(mailbox.address, at);
    try {
      const snapshot = await readSnapshot(cache);
      if (snapshot === null || snapshot.folders.length === 0) return 'skipped';
      const json = JSON.stringify(snapshot);
      const digest = await sha256(json);
      const row = await store.get(CACHE_SNAPSHOT_RECORD_TYPE, mailbox.address);
      const current = row === null ? null : parseSnapshotRecord(row.plaintext);
      // A newer build's record is not this one's to overwrite.
      if (row !== null && current === null) return 'skipped';
      if (current !== null && isOf(current, mailbox)) {
        if (at - current.writtenAt < SNAPSHOT_INTERVAL_MS || current.digest === digest) {
          return 'skipped';
        }
      }

      const fileId = crypto.randomUUID();
      await files.put(fileId, new TextEncoder().encode(json));
      const record: SnapshotRecord = {
        fileId,
        host: mailbox.imap.host,
        username: mailbox.imap.username,
        writtenAt: at,
        digest,
      };
      try {
        await store.put({
          type: CACHE_SNAPSHOT_RECORD_TYPE,
          naturalKey: mailbox.address,
          plaintext: JSON.stringify(record),
          precondition:
            row === null ? { expect: 'absent' } : { expect: 'revision', revision: row.revision },
        });
      } catch (error) {
        // Lost the race: nothing names the file, so it goes now. Any other failure may have
        // written the record, so the file stays for `collectFiles` to judge.
        if (error instanceof VaultApiError && error.code === 'CONFLICT') {
          await files.remove(fileId).catch(() => undefined);
        }
        return 'failed';
      }
      // The file it replaced goes now rather than after `collectFiles`' grace, or a day of writes
      // would pile up against the cap. A device reading it this moment only syncs from scratch.
      if (current !== null) await files.remove(current.fileId).catch(() => undefined);
      // This cache holds what it wrote, so its next open has nothing to download; but only if it
      // still does: a clear and part of a rebuild since would be marked as holding all of it.
      const after = await readSnapshot(cache);
      const isUnchanged = after !== null && (await sha256(JSON.stringify(after))) === digest;
      if (isUnchanged && !isStale()) await cache.putSnapshotDigest(digest);
      return 'saved';
    } catch {
      return 'failed';
    }
  };

  return { save };
};

export type SnapshotWriter = ReturnType<typeof createSnapshotWriter>;
