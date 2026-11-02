import { DRAFT_RECORD_TYPE, fileIdsOfDraft, parseDraftRecord } from '../compose/draft-record.ts';
import { fileIdsOfSent, parseSentRecord, SENT_RECORD_TYPE } from '../compose/sent-record.ts';
import type { FileStore } from './file-store.ts';
import type { RecordStore } from './record-store.ts';

/** Room for a file to be named: an upload lands before the save that names it. */
export const FILE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The one way a file is deleted: no draft (tombstones included) and no sent record names it, and it
 * is past its grace. A row whose object is already gone goes the same way, since `remove` takes both.
 * Answers how many it removed.
 */
export const collectFiles = async (
  store: RecordStore,
  files: FileStore,
  now: number,
): Promise<number> => {
  // Drafts first, one after the other. A send writes its sent record before its tombstone stops
  // naming the file, so a file only ever moves from draft to sent: in this order a list catches it in
  // at least one. The other order, or both at once, can miss it in both and delete a sent attachment.
  const drafts = await store.list(DRAFT_RECORD_TYPE);
  const sent = await store.list(SENT_RECORD_TYPE);
  const named = [
    ...drafts.map(({ plaintext }) => {
      const record = parseDraftRecord(plaintext);
      return record === null ? null : fileIdsOfDraft(record);
    }),
    ...sent.map(({ plaintext }) => {
      const record = parseSentRecord(plaintext);
      return record === null ? null : fileIdsOfSent(record);
    }),
  ];
  // A build that can't read a record must not delete what the record names.
  if (named.includes(null)) return 0;
  const referenced = new Set(named.flatMap(ids => ids ?? []));

  const { files: stored } = await files.list();
  const collectable = stored.filter(
    ({ id, createdAt }) => !referenced.has(id) && now - createdAt >= FILE_GRACE_MS,
  );
  let removed = 0;
  for (const { id } of collectable) {
    try {
      await files.remove(id);
      removed += 1;
    } catch {
      // The next unlock finds it again.
    }
  }
  return removed;
};
