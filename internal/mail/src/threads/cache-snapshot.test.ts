import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it, vi } from 'vitest';
import type { MailClient, MailConnectionFailure, MailTask, Result } from '../connection.ts';
import { fakeFileStore } from '../testing/fake-file-store.ts';
import { stubImapClient } from '../testing/fake-imap-client.ts';
import { fakeRecordStore } from '../testing/fake-record-store.ts';
import { memoryMailCache } from '../testing/memory-mail-cache.ts';
import { VaultApiError } from '../vault/api.ts';
import type { FileStore } from '../vault/file-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import type { MailCache } from './cache.ts';
import {
  CACHE_SNAPSHOT_RECORD_TYPE,
  createSnapshotWriter,
  parseSnapshotRecord,
  restoreSnapshot,
  SNAPSHOT_INTERVAL_MS,
} from './cache-snapshot.ts';
import { syncMailbox } from './sync.ts';

const MAILBOX = { address: 'me@x.co', imap: { host: 'imap.x.co', username: 'me@x.co' } };

const summary = (uid: number, seq: number, flags: readonly string[] = []): ImapMessageSummary => ({
  seq,
  uid,
  flags,
  internalDate: null,
  size: 100,
  envelope: {
    date: null,
    subject: `Message ${uid}`,
    subjectRaw: null,
    from: [{ name: 'Ann', mailbox: 'ann', host: 'y.co' }],
    sender: [],
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
    inReplyTo: null,
    messageId: `<m${uid}@y.co>`,
  },
  references: [],
  gmailThreadId: null,
  attachmentNames: [],
});

/** An IMAP server holding an INBOX and nothing else, enough to sync against. */
const fakeServer = (initial: { uidValidity: number; uids: readonly number[] }) => {
  const inbox = {
    uidValidity: initial.uidValidity,
    messages: initial.uids.map(uid => ({ uid, flags: [] as readonly string[] })),
  };
  const summaries = () =>
    inbox.messages.map(({ uid, flags }, index) => summary(uid, index + 1, flags));
  /** The uids or sequence numbers an IMAP set names, `*` being `top`. */
  const inSet = (set: string, top: number) => (n: number) =>
    set.split(',').some(part => {
      const [from, to = from] = part.split(':').map(end => (end === '*' ? top : Number(end)));
      if (from === undefined || to === undefined) return false;
      return n >= Math.min(from, to) && n <= Math.max(from, to);
    });
  const maxUid = () => Math.max(0, ...inbox.messages.map(({ uid }) => uid));
  const fetchSummariesBySeq = vi.fn(async (set: string) => ({
    ok: true as const,
    value: summaries().filter(({ seq }) => inSet(set, inbox.messages.length)(seq)),
  }));
  const client: MailClient = {
    ...stubImapClient({
      list: async () => ({ ok: true, value: [{ name: 'INBOX', delimiter: '/', attributes: [] }] }),
      select: async name => ({
        ok: true,
        value: {
          name,
          exists: inbox.messages.length,
          uidValidity: inbox.uidValidity,
          uidNext: maxUid() + 1,
          flags: [],
          permanentFlags: [],
          readOnly: false,
        },
      }),
      fetchSummaries: async set => ({
        ok: true,
        value: summaries().filter(({ uid }) => inSet(set, maxUid())(uid)),
      }),
      fetchSummariesBySeq,
      fetchFlags: async set => ({
        ok: true,
        value: summaries()
          .filter(({ uid }) => inSet(set, maxUid())(uid))
          .map(({ uid, flags }) => ({ uid, flags })),
      }),
    }),
    ensureSelected: async () => {
      throw new Error('sync selects afresh');
    },
  };
  const run = <T>(task: MailTask<T>): Promise<Result<T, MailConnectionFailure>> => task.run(client);
  return { inbox, run, fetchSummariesBySeq, summaries };
};

const uidsOf = async (cache: MailCache) =>
  (await cache.folder('inbox').listSummaries()).map(({ uid }) => uid).toSorted((a, b) => a - b);

/** A vault, and a device whose cache has synced `server` and written its snapshot. */
const savedWorld = async (server: ReturnType<typeof fakeServer>) => {
  const records = fakeRecordStore();
  const files = fakeFileStore();
  const laptop = memoryMailCache();
  await syncMailbox(server.run, laptop);
  const writer = createSnapshotWriter({ store: records.store, files: files.store });
  expect(await writer.save(MAILBOX, laptop)).toBe('saved');
  return { records, files, laptop };
};

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('restoreSnapshot', () => {
  it('fills an empty cache with the list another device saved', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files, laptop } = await savedWorld(server);
    const phone = memoryMailCache();

    expect(
      await restoreSnapshot({
        store: records.store,
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
      }),
    ).toBe(true);
    expect(await phone.folder('inbox').getSync()).toEqual(await laptop.folder('inbox').getSync());
    expect(await phone.folder('inbox').listSummaries()).toEqual(
      await laptop.folder('inbox').listSummaries(),
    );
  });

  it('keeps a snapshot in one file, named by its record', async () => {
    const server = fakeServer({ uidValidity: 7, uids: range(1, 150) });
    const { records, files } = await savedWorld(server);
    expect(files.files.size).toBe(1);
    const row = await records.store.get(CACHE_SNAPSHOT_RECORD_TYPE, MAILBOX.address);
    expect(files.files.has(parseSnapshotRecord(row?.plaintext ?? '')?.fileId ?? '')).toBe(true);
  });

  it('leaves a device that already has a cache alone', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    await phone
      .folder('sent')
      .putSync({ name: 'Sent', uidValidity: 1, lastUid: 0, complete: true });

    expect(
      await restoreSnapshot({
        store: records.store,
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
      }),
    ).toBe(false);
    expect(await uidsOf(phone)).toEqual([]);
  });

  it('ignores a snapshot of another login, whose uids name other mail', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    const moved = { ...MAILBOX, imap: { ...MAILBOX.imap, host: 'imap.elsewhere.co' } };

    expect(
      await restoreSnapshot({
        store: records.store,
        files: files.store,
        cache: phone,
        mailbox: moved,
      }),
    ).toBe(false);
    expect(await uidsOf(phone)).toEqual([]);
  });

  it.each<[string, (files: FileStore) => FileStore]>([
    ['is gone', files => ({ ...files, get: async () => null })],
    [
      'does not open',
      files => ({
        ...files,
        get: async () => {
          throw new Error('the file did not authenticate');
        },
      }),
    ],
    ['is not a snapshot', files => ({ ...files, get: async () => new Uint8Array([1, 2, 3]) })],
  ])(
    'restores nothing when the file %s, and the sync reads from scratch',
    async (_label, broken) => {
      const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
      const { records, files } = await savedWorld(server);
      const phone = memoryMailCache();

      expect(
        await restoreSnapshot({
          store: records.store,
          files: broken(files.store),
          cache: phone,
          mailbox: MAILBOX,
        }),
      ).toBe(false);
      const { state } = await syncMailbox(server.run, phone);
      expect(state.status).toBe('synced');
      expect(await uidsOf(phone)).toEqual([1, 2, 3]);
    },
  );

  it('writes nothing once a lock has cleared the cache meanwhile', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    let isLocked = false;
    const lockingFiles: FileStore = {
      ...files.store,
      get: async fileId => {
        const bytes = await files.store.get(fileId);
        isLocked = true;
        return bytes;
      },
    };

    expect(
      await restoreSnapshot({
        store: records.store,
        files: lockingFiles,
        cache: phone,
        mailbox: MAILBOX,
        isStale: () => isLocked,
      }),
    ).toBe(false);
    expect(await uidsOf(phone)).toEqual([]);
  });

  it("writes no mark once a lock clears the cache during a folder's summaries", async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    let isLocked = false;
    const locking: MailCache = {
      ...phone,
      folder: folder => {
        const folderCache = phone.folder(folder);
        return {
          ...folderCache,
          putSummaries: async summaries => {
            await folderCache.putSummaries(summaries);
            // The teardown: the generation moves, then the cache is cleared.
            isLocked = true;
            await phone.clear();
          },
        };
      },
    };

    expect(
      await restoreSnapshot({
        store: records.store,
        files: files.store,
        cache: locking,
        mailbox: MAILBOX,
        isStale: () => isLocked,
      }),
    ).toBe(false);
    expect(await phone.folder('inbox').getSync()).toBeNull();
  });

  it('restores nothing when the vault cannot be reached', async () => {
    const offline: RecordStore = {
      ...fakeRecordStore().store,
      get: async () => {
        throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    };
    expect(
      await restoreSnapshot({
        store: offline,
        files: fakeFileStore().store,
        cache: memoryMailCache(),
        mailbox: MAILBOX,
      }),
    ).toBe(false);
  });
});

describe('the sync after a restore', () => {
  /** A phone seeded from the laptop's snapshot, after `change` happened on the server. */
  const restoredAfter = async (
    uids: readonly number[],
    change: (server: ReturnType<typeof fakeServer>) => void,
  ) => {
    const server = fakeServer({ uidValidity: 7, uids });
    const { records, files } = await savedWorld(server);
    change(server);
    const phone = memoryMailCache();
    expect(
      await restoreSnapshot({
        store: records.store,
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
      }),
    ).toBe(true);
    server.fetchSummariesBySeq.mockClear();
    const { state } = await syncMailbox(server.run, phone);
    expect(state.status).toBe('synced');
    return { server, phone };
  };

  it('drops what a restore cut short left without a mark', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const phone = memoryMailCache();
    // Summaries written, the mark never was; uid 9 has since gone from the server.
    await phone.folder('inbox').putSummaries([summary(1, 1), summary(9, 2)]);
    const { state } = await syncMailbox(server.run, phone);
    expect(state.status).toBe('synced');
    expect(await uidsOf(phone)).toEqual([1, 2, 3]);
  });

  it('reads on from the snapshot: new mail, flags changed and mail gone since', async () => {
    const { server, phone } = await restoredAfter([1, 2, 3, 4], server => {
      server.inbox.messages = server.inbox.messages.filter(({ uid }) => uid !== 2);
      server.inbox.messages = server.inbox.messages.map(message =>
        message.uid === 3 ? { ...message, flags: ['\\Seen'] } : message,
      );
      server.inbox.messages.push({ uid: 5, flags: [] });
    });

    expect(await uidsOf(phone)).toEqual([1, 3, 4, 5]);
    const flagged = (await phone.folder('inbox').listSummaries()).find(({ uid }) => uid === 3);
    expect(flagged?.flags).toEqual(['\\Seen']);
    // Incremental: no window was read from scratch.
    expect(server.fetchSummariesBySeq).not.toHaveBeenCalled();
    expect((await phone.folder('inbox').getSync())?.lastUid).toBe(5);
  });

  it('drops a snapshot of a folder renumbered since', async () => {
    const { phone } = await restoredAfter([1, 2, 3], server => {
      server.inbox.uidValidity = 8;
      server.inbox.messages = [
        { uid: 1, flags: [] },
        { uid: 2, flags: [] },
      ];
    });

    expect(await uidsOf(phone)).toEqual([1, 2]);
    expect((await phone.folder('inbox').getSync())?.uidValidity).toBe(8);
  });

  it('starts a folder over when more mail arrived since than one window holds', async () => {
    const { phone } = await restoredAfter([1, 2, 3], server => {
      server.inbox.messages.push(...range(10, 260).map(uid => ({ uid, flags: [] })));
    });

    // The newest 200, with no gap between them and the snapshot's mail left in.
    expect(await uidsOf(phone)).toEqual(range(61, 260));
    expect((await phone.folder('inbox').getSync())?.complete).toBe(false);
  });

  it('misses no mail when a sync lands while the snapshot is being read', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2] });
    const laptop = memoryMailCache();
    await syncMailbox(server.run, laptop);
    server.inbox.messages.push({ uid: 3, flags: [] });
    // The laptop's next sync lands between the snapshot's two reads of the inbox, whichever is first.
    let hasSynced = false;
    const thenSync = async <T>(folder: string, value: T): Promise<T> => {
      if (folder === 'inbox' && !hasSynced) {
        hasSynced = true;
        await syncMailbox(server.run, laptop);
      }
      return value;
    };
    const racing: MailCache = {
      ...laptop,
      folder: folder => {
        const inner = laptop.folder(folder);
        return {
          ...inner,
          getSync: async () => thenSync(folder, await inner.getSync()),
          listSummaries: async () => thenSync(folder, await inner.listSummaries()),
        };
      },
    };
    const records = fakeRecordStore();
    const files = fakeFileStore();
    await createSnapshotWriter({ store: records.store, files: files.store }).save(MAILBOX, racing);
    // Mail 4 arrives after the snapshot; 3 is in it under the older mark.
    server.inbox.messages.push({ uid: 4, flags: [] });

    const phone = memoryMailCache();
    await restoreSnapshot({
      store: records.store,
      files: files.store,
      cache: phone,
      mailbox: MAILBOX,
    });
    await syncMailbox(server.run, phone);
    expect(await uidsOf(phone)).toEqual([1, 2, 3, 4]);
  });
});

describe('createSnapshotWriter', () => {
  const world = async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const cache = memoryMailCache();
    await syncMailbox(server.run, cache);
    const records = fakeRecordStore();
    const files = fakeFileStore();
    let time = 1_000_000;
    const writer = (store: RecordStore = records.store, fileStore: FileStore = files.store) =>
      createSnapshotWriter({ store, files: fileStore, now: () => time });
    const fileIdNamed = async () => {
      const row = await records.store.get(CACHE_SNAPSHOT_RECORD_TYPE, MAILBOX.address);
      return parseSnapshotRecord(row?.plaintext ?? '')?.fileId;
    };
    return {
      server,
      cache,
      records,
      files,
      writer,
      fileIdNamed,
      later: (ms: number) => {
        time += ms;
      },
    };
  };

  it('writes nothing when the cache is cleared while it reads', async () => {
    const { cache, files, writer, fileIdNamed } = await world();
    // A clear between a folder's mark and its summaries: the mark would claim mail none of them hold.
    const clearing: MailCache = {
      ...cache,
      folder: folder => {
        const folderCache = cache.folder(folder);
        return {
          ...folderCache,
          listSummaries: async () => {
            await cache.clear();
            return folderCache.listSummaries();
          },
        };
      },
    };
    expect(await writer().save(MAILBOX, clearing)).toBe('skipped');
    expect(await fileIdNamed()).toBeUndefined();
    expect(files.files.size).toBe(0);
  });

  it('writes at most once an interval, from this device or another', async () => {
    const { server, cache, writer, later } = await world();
    const laptop = writer();
    expect(await laptop.save(MAILBOX, cache)).toBe('saved');
    server.inbox.messages.push({ uid: 4, flags: [] });
    await syncMailbox(server.run, cache);
    later(SNAPSHOT_INTERVAL_MS - 1);
    expect(await laptop.save(MAILBOX, cache)).toBe('skipped');
    // A second device, or a second CLI run, knows from the record.
    expect(await writer().save(MAILBOX, cache)).toBe('skipped');
    later(1);
    expect(await writer().save(MAILBOX, cache)).toBe('saved');
  });

  it('writes nothing when the list has not changed', async () => {
    const { cache, writer, later } = await world();
    expect(await writer().save(MAILBOX, cache)).toBe('saved');
    later(SNAPSHOT_INTERVAL_MS);
    expect(await writer().save(MAILBOX, cache)).toBe('skipped');
  });

  it('writes nothing for a mailbox that has not synced', async () => {
    const { writer, files } = await world();
    expect(await writer().save(MAILBOX, memoryMailCache())).toBe('skipped');
    expect(files.files.size).toBe(0);
  });

  it('deletes the file it replaced, so one file per mailbox stays', async () => {
    const { server, cache, writer, later, files, fileIdNamed } = await world();
    await writer().save(MAILBOX, cache);
    const first = await fileIdNamed();
    server.inbox.messages.push({ uid: 4, flags: [] });
    await syncMailbox(server.run, cache);
    later(SNAPSHOT_INTERVAL_MS);
    expect(await writer().save(MAILBOX, cache)).toBe('saved');
    const second = await fileIdNamed();
    expect(second).not.toBe(first);
    expect([...files.files.keys()]).toEqual([second]);
  });

  it('gives up on losing the race, deleting its own file and keeping the winner', async () => {
    const { server, cache, writer, later, records, files, fileIdNamed } = await world();
    await writer().save(MAILBOX, cache);
    server.inbox.messages.push({ uid: 4, flags: [] });
    await syncMailbox(server.run, cache);
    later(SNAPSHOT_INTERVAL_MS);
    // Another device swaps the record in between this one's read and its write.
    let winner: string | undefined;
    const racing: RecordStore = {
      ...records.store,
      put: async input => {
        await writer().save({ ...MAILBOX }, cache);
        winner = await fileIdNamed();
        return records.store.put(input);
      },
    };
    expect(await writer(racing).save(MAILBOX, cache)).toBe('failed');
    expect(await fileIdNamed()).toBe(winner);
    expect([...files.files.keys()]).toEqual([winner]);
  });

  it('writes nothing over a full vault, and leaves the snapshot it has', async () => {
    const { server, cache, writer, later, files, fileIdNamed } = await world();
    await writer().save(MAILBOX, cache);
    const kept = await fileIdNamed();
    server.inbox.messages.push({ uid: 4, flags: [] });
    await syncMailbox(server.run, cache);
    later(SNAPSHOT_INTERVAL_MS);
    const full: FileStore = {
      ...files.store,
      put: async () => {
        throw new VaultApiError('STORAGE_FULL', 'File storage is full', 413);
      },
    };
    expect(await writer(undefined, full).save(MAILBOX, cache)).toBe('failed');
    expect(await fileIdNamed()).toBe(kept);
    expect([...files.files.keys()]).toEqual([kept]);
  });

  it('keeps its file when the record write fails for another reason', async () => {
    const { cache, writer, records, files } = await world();
    const offline: RecordStore = {
      ...records.store,
      put: async () => {
        throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    };
    expect(await writer(offline).save(MAILBOX, cache)).toBe('failed');
    // It may have landed: `collectFiles` judges it once its grace is over.
    expect(files.files.size).toBe(1);
  });

  it('leaves a record this build cannot read alone', async () => {
    const { cache, writer, records, files } = await world();
    await records.store.put({
      type: CACHE_SNAPSHOT_RECORD_TYPE,
      naturalKey: MAILBOX.address,
      plaintext: '{"from":"a newer build"}',
    });
    expect(await writer().save(MAILBOX, cache)).toBe('skipped');
    expect(files.files.size).toBe(0);
  });
});
