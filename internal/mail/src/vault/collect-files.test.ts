import { describe, expect, it } from 'vitest';
import { ADDRESS_RECORD_TYPE } from '../addresses/record.ts';
import { DRAFT_RECORD_TYPE, type DraftRecord } from '../compose/draft-record.ts';
import { SENT_RECORD_TYPE, type SentRecord } from '../compose/sent-record.ts';
import { fakeFileStore } from '../testing/fake-file-store.ts';
import { fakeRecordStore } from '../testing/fake-record-store.ts';
import { CACHE_SNAPSHOT_RECORD_TYPE, type SnapshotRecord } from '../threads/cache-snapshot.ts';
import { collectFiles, FILE_GRACE_MS } from './collect-files.ts';
import type { FileStore } from './file-store.ts';
import type { RecordStore } from './record-store.ts';

const NOW = 100 * FILE_GRACE_MS;
const OLD = NOW - FILE_GRACE_MS;

const reference = (id: string) => ({ id, name: `${id}.bin`, size: 1, kind: 'other' as const });
const frozen = (fileId: string) => ({ head: '', splices: [{ at: 0, fileId }] });
const send = (fileId: string) => ({
  messageId: '<m@x.co>',
  opId: 'op',
  state: 'submitting' as const,
  claimedAt: 0,
  message: frozen(fileId),
  target: 'vault' as const,
});
const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  from: 'me@x.co',
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
  contentVersion: 1,
  ...over,
});
const sent = (over: Partial<SentRecord>): SentRecord => ({
  messageId: '<m@x.co>',
  at: 0,
  date: '',
  from: 'me@x.co',
  to: '',
  cc: '',
  subject: '',
  body: '',
  ...over,
});

/** A vault holding these records, and the one file `kept`, stored at `createdAt`. */
const world = async ({
  drafts = [],
  sentRecords = [],
  createdAt = OLD,
}: {
  drafts?: readonly DraftRecord[];
  sentRecords?: readonly SentRecord[];
  createdAt?: number;
}) => {
  const { store: records, rows, key } = fakeRecordStore();
  for (const [index, record] of drafts.entries()) {
    await records.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: `draft-${index}`,
      plaintext: JSON.stringify(record),
    });
  }
  for (const [index, record] of sentRecords.entries()) {
    await records.put({
      type: SENT_RECORD_TYPE,
      naturalKey: `sent-${index}`,
      plaintext: JSON.stringify(record),
    });
  }
  const { store: fileStore, files } = fakeFileStore();
  await fileStore.put('kept', new Uint8Array([1]));
  const row = files.get('kept');
  if (row === undefined) throw new Error('the fixture stored nothing');
  row.createdAt = createdAt;
  return { records, rows, key, fileStore, files };
};

describe('collectFiles', () => {
  it('removes a file nothing names, once it is past its grace', async () => {
    const { records, fileStore, files } = await world({});
    expect(await collectFiles(records, fileStore, NOW)).toBe(1);
    expect(files.has('kept')).toBe(false);
  });

  it('keeps a file nothing names yet, inside its 24 hours', async () => {
    const { records, fileStore, files } = await world({ createdAt: OLD + 1 });
    expect(await collectFiles(records, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it.each<[string, Partial<DraftRecord>]>([
    ["a draft's attachments", { attachments: [reference('kept')] }],
    ['a send alone', { send: send('kept') }],
    ['an unconfirmed send alone', { unconfirmedSend: send('kept') }],
    ['a tombstone', { deletedAt: 1, attachments: [reference('kept')] }],
    ["a tombstone's unconfirmed send", { deletedAt: 1, unconfirmedSend: send('kept') }],
  ])('keeps a file named only by %s', async (_label, over) => {
    const { records, fileStore, files } = await world({ drafts: [draft(over)] });
    expect(await collectFiles(records, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it.each<[string, Partial<SentRecord>]>([
    ["a sent record's attachments", { attachments: [reference('kept')] }],
    ["a sent record's message", { message: frozen('kept') }],
  ])('keeps a file named only by %s', async (_label, over) => {
    const { records, fileStore, files } = await world({ sentRecords: [sent(over)] });
    expect(await collectFiles(records, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it('frees a file once a send is done with it: the tombstone no longer names it', async () => {
    const { records, fileStore, files } = await world({
      drafts: [draft({ deletedAt: 1, sentMessageId: '<m@x.co>' })],
    });
    expect(await collectFiles(records, fileStore, NOW)).toBe(1);
    expect(files.has('kept')).toBe(false);
  });

  describe('cache snapshots', () => {
    const CURRENT = '00000000-0000-4000-8000-000000000001';
    const REPLACED = '00000000-0000-4000-8000-000000000002';
    const snapshot = (fileId: string): SnapshotRecord => ({
      fileId,
      host: 'imap.x.co',
      username: 'me@x.co',
      writtenAt: 0,
      digest: 'd',
    });

    /** A vault with a snapshot of `me@x.co` naming CURRENT, both files old, and the address if `hasAddress`. */
    const snapshotWorld = async ({ hasAddress }: { hasAddress: boolean }) => {
      const stored = await world({});
      await stored.records.put({
        type: CACHE_SNAPSHOT_RECORD_TYPE,
        naturalKey: 'me@x.co',
        plaintext: JSON.stringify(snapshot(CURRENT)),
      });
      if (hasAddress) {
        // Only its presence counts, so the plaintext is not an address record's.
        await stored.records.put({
          type: ADDRESS_RECORD_TYPE,
          naturalKey: 'me@x.co',
          plaintext: '',
        });
      }
      for (const id of [CURRENT, REPLACED]) {
        await stored.fileStore.put(id, new Uint8Array([1]));
        const row = stored.files.get(id);
        if (row === undefined) throw new Error('the fixture stored nothing');
        row.createdAt = OLD;
      }
      return stored;
    };

    it('keeps the file a snapshot names and collects the one it replaced', async () => {
      const { records, fileStore, files } = await snapshotWorld({ hasAddress: true });
      // `kept` is named by nothing here either.
      expect(await collectFiles(records, fileStore, NOW)).toBe(2);
      expect([...files.keys()]).toEqual([CURRENT]);
    });

    it('collects the snapshot of an address that has been removed', async () => {
      const { records, fileStore, files } = await snapshotWorld({ hasAddress: false });
      expect(await collectFiles(records, fileStore, NOW)).toBe(3);
      expect(files.size).toBe(0);
    });
  });

  it.each([
    ['a draft', DRAFT_RECORD_TYPE],
    ['a sent', SENT_RECORD_TYPE],
    ['a cache snapshot', CACHE_SNAPSHOT_RECORD_TYPE],
  ])('deletes nothing when %s row does not parse', async (_label, type) => {
    const { records, fileStore, files } = await world({});
    await records.put({ type, naturalKey: 'unreadable', plaintext: '{"not":"this build"}' });
    expect(await collectFiles(records, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it('deletes nothing when a row is not even JSON', async () => {
    const { records, fileStore, files } = await world({});
    await records.put({ type: DRAFT_RECORD_TYPE, naturalKey: 'garbled', plaintext: 'not json' });
    expect(await collectFiles(records, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it('keeps a file a send on another device moves from its draft to its sent record mid-read', async () => {
    const named = reference('kept');
    const { records, fileStore, files } = await world({
      drafts: [draft({ attachments: [named], send: send('kept') })],
    });
    // What device A writes: the sent record, then the tombstone that stops naming the file.
    const sendCompletes = async () => {
      await records.put({
        type: SENT_RECORD_TYPE,
        naturalKey: 'sent-0',
        plaintext: JSON.stringify(sent({ attachments: [named], message: frozen('kept') })),
      });
      await records.put({
        type: DRAFT_RECORD_TYPE,
        naturalKey: 'draft-0',
        plaintext: JSON.stringify(draft({ deletedAt: 1, sentMessageId: '<m@x.co>' })),
      });
    };
    let hasSendCompleted = false;
    const racing: RecordStore = {
      ...records,
      list: async type => {
        // The slower of the two reads, so one started alongside it finishes first.
        if (type === DRAFT_RECORD_TYPE) await new Promise(resolve => setTimeout(resolve));
        const rows = await records.list(type);
        // Device A's writes land straight after whichever list answers first.
        if (!hasSendCompleted) {
          hasSendCompleted = true;
          await sendCompletes();
        }
        return rows;
      },
    };

    expect(await collectFiles(racing, fileStore, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });

  it('removes an unreferenced row whose object is already gone', async () => {
    // A Worker killed between the reservation and the `put`: the row is listed, `get` answers 404.
    const removed: string[] = [];
    const rowOnly: FileStore = {
      put: async () => undefined,
      get: async () => null,
      list: async () => ({
        files: [{ id: 'ghost', size: 9, createdAt: OLD }],
        usedBytes: 9,
        capBytes: 100,
      }),
      remove: async fileId => {
        removed.push(fileId);
      },
    };
    const { records } = await world({});
    expect(await collectFiles(records, rowOnly, NOW)).toBe(1);
    expect(removed).toEqual(['ghost']);
  });

  it('counts only what it removed, and leaves the rest for the next unlock', async () => {
    const { records, fileStore, files } = await world({});
    const refusing: FileStore = {
      ...fileStore,
      remove: async () => {
        throw new Error('offline');
      },
    };
    expect(await collectFiles(records, refusing, NOW)).toBe(0);
    expect(files.has('kept')).toBe(true);
  });
});
