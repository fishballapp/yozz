import type { ImapMessageSummary } from '@yozz.app/imap';
import { z } from 'zod';
import { VaultApiError } from '../vault/api.ts';
import type { FileStore } from '../vault/file-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import type { FolderSync, MailCache } from './cache.ts';
import { FOLDERS, type Folder } from './thread.ts';

/**
 * A copy of one mailbox's list in the vault, so a device with no cache for it shows the list at once
 * and syncs on from there instead of from nothing. Each folder's sync mark and summaries, no bodies.
 * The list is too big for a record, so it is a vault file of JSON, named by a small record per
 * mailbox; a file is never replaced, so each write is a new file and a compare-and-swap of the
 * record. All of it is derived: a snapshot lost, stale, refused or unreadable costs only the speed-up.
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

/**
 * Each folder that has synced, its mark read before its summaries: a sync writes summaries before
 * the mark, so a summary newer than the mark is read again by the next sync, while a mark newer
 * than its summaries would leave the mail between them unread for good. Then the mark is read again:
 * a clear or a start-over meanwhile deletes summaries the first mark still claims, and a snapshot of
 * that would hide them on every device it seeds. Answers null then, and a later sync writes it.
 */
const readSnapshot = async (cache: MailCache): Promise<Snapshot | null> => {
  const folders = await Promise.all(
    FOLDERS.map(async folder => {
      const folderCache = cache.folder(folder);
      const sync = await folderCache.getSync();
      if (sync === null) return [];
      const summaries = await folderCache.listSummaries();
      const after = await folderCache.getSync();
      if (JSON.stringify(after) !== JSON.stringify(sync)) return null;
      return [{ folder, sync, summaries }];
    }),
  );
  if (folders.includes(null)) return null;
  return { folders: folders.flatMap(folder => folder ?? []) };
};

/** The device has a cache of the mailbox once any folder of it has synced. */
const hasCache = async (cache: MailCache): Promise<boolean> =>
  (await Promise.all(FOLDERS.map(folder => cache.folder(folder).getSync()))).some(
    mark => mark !== null,
  );

/**
 * When the device has no cache of the mailbox, fills it from the vault's snapshot, if there is one
 * of this mailbox that opens. Answers whether it did. The sync after it takes the snapshot as a
 * cache like any other, however old: a renumbered folder is dropped, a gap wider than the window
 * starts the folder over, flags are read again and mail gone since is dropped.
 */
export const restoreSnapshot = async ({
  store,
  files,
  cache,
  mailbox,
  isStale = () => false,
}: {
  readonly store: RecordStore;
  readonly files: FileStore;
  readonly cache: MailCache;
  readonly mailbox: SnapshotMailbox;
  /** A lock or a removal meanwhile has cleared the cache, which a write now would refill. */
  readonly isStale?: () => boolean;
}): Promise<boolean> => {
  try {
    if (await hasCache(cache)) return false;
    const row = await store.get(CACHE_SNAPSHOT_RECORD_TYPE, mailbox.address);
    const record = row === null ? null : parseSnapshotRecord(row.plaintext);
    if (record === null || !isOf(record, mailbox)) return false;
    const bytes = await files.get(record.fileId);
    if (bytes === null) return false;
    const parsed = snapshotSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    if (!parsed.success || isStale()) return false;
    // Summaries left with no mark (a seed cut short) would never be dropped by a sync.
    await cache.clear();
    for (const { folder, sync, summaries } of parsed.data.folders) {
      if (isStale()) return false;
      const folderCache = cache.folder(folder);
      // Summaries before the mark, as a sync writes them; see `readSnapshot`.
      await folderCache.putSummaries(summaries);
      // A lock during that write has cleared the cache; a mark written now would claim mail it lacks.
      if (isStale()) return false;
      await folderCache.putSync(sync);
    }
    return parsed.data.folders.length > 0;
  } catch {
    // Unreachable, refused, or a file that does not open: the sync reads from scratch.
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

  const save = async (mailbox: SnapshotMailbox, cache: MailCache): Promise<SaveOutcome> => {
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
      return 'saved';
    } catch {
      return 'failed';
    }
  };

  return { save };
};

export type SnapshotWriter = ReturnType<typeof createSnapshotWriter>;
