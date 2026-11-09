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
  listSnapshotRecords,
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
        records: listSnapshotRecords(records.store),
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

  it('leaves Junk out, so spam seeds no other device', async () => {
    const records = fakeRecordStore();
    const files = fakeFileStore();
    const laptop = memoryMailCache();
    await syncMailbox(fakeServer({ uidValidity: 7, uids: [1] }).run, laptop);
    await laptop
      .folder('junk')
      .putSync({ name: 'Spam', uidValidity: 3, lastUid: 9, complete: true });
    await laptop.folder('junk').putSummaries([summary(9, 1)]);
    const writer = createSnapshotWriter({ store: records.store, files: files.store });
    expect(await writer.save(MAILBOX, laptop)).toBe('saved');
    const phone = memoryMailCache();

    await restoreSnapshot({
      records: listSnapshotRecords(records.store),
      files: files.store,
      cache: phone,
      mailbox: MAILBOX,
    });
    expect(await uidsOf(phone)).toEqual([1]);
    expect(await phone.folder('junk').getSync()).toBeNull();
    expect(await phone.folder('junk').listSummaries()).toEqual([]);
  });

  it('fills a folder this device has not synced, and leaves the others alone', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    const sent = { name: 'Sent', uidValidity: 1, lastUid: 0, complete: true };
    await phone.folder('sent').putSync(sent);

    expect(
      await restoreSnapshot({
        records: listSnapshotRecords(records.store),
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
      }),
    ).toBe(true);
    expect(await uidsOf(phone)).toEqual([1, 2, 3]);
    expect(await phone.folder('sent').getSync()).toEqual(sent);
  });

  it('ignores a snapshot of another login, whose uids name other mail', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2, 3] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    const moved = { ...MAILBOX, imap: { ...MAILBOX.imap, host: 'imap.elsewhere.co' } };

    expect(
      await restoreSnapshot({
        records: listSnapshotRecords(records.store),
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
          records: listSnapshotRecords(records.store),
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
        records: listSnapshotRecords(records.store),
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
        records: listSnapshotRecords(records.store),
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
      list: async () => {
        throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    };
    expect(
      await restoreSnapshot({
        records: listSnapshotRecords(offline),
        files: fakeFileStore().store,
        cache: memoryMailCache(),
        mailbox: MAILBOX,
      }),
    ).toBe(false);
  });
});

describe('restoreSnapshot over a cache this device already has', () => {
  type Server = ReturnType<typeof fakeServer>;

  /**
   * The phone syncs `server`, then `change` happens on it, then the laptop syncs from scratch and
   * saves its snapshot, then `later` happens on it. The phone has not synced since.
   */
  const staleWorld = async (
    uids: readonly number[],
    change: (server: Server) => void,
    later: (server: Server) => void = () => {},
  ) => {
    const server = fakeServer({ uidValidity: 7, uids });
    const phone = memoryMailCache();
    await syncMailbox(server.run, phone);
    change(server);
    const { records, files } = await savedWorld(server);
    later(server);
    const filesGet = vi.spyOn(files.store, 'get');
    const restore = (overrides: Partial<Parameters<typeof restoreSnapshot>[0]> = {}) =>
      restoreSnapshot({
        records: listSnapshotRecords(records.store),
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
        ...overrides,
      });
    return { server, phone, records, files, filesGet, restore };
  };

  const deliver = (server: Server, uids: readonly number[]) =>
    server.inbox.messages.push(...uids.map(uid => ({ uid, flags: [] as readonly string[] })));
  const expunge = (server: Server, gone: (uid: number) => boolean) => {
    server.inbox.messages = server.inbox.messages.filter(({ uid }) => !gone(uid));
  };

  /**
   * What a mark promises: every message of the server's from the lowest cached uid up to `lastUid`
   * is cached, and every one below it too once the folder is `complete`. Anything else is mail no
   * sync or Older mail would ever fetch.
   */
  const expectNoHiddenMail = async (cache: MailCache, server: Server) => {
    const mark = await cache.folder('inbox').getSync();
    if (mark === null) return;
    const cached = new Set(await uidsOf(cache));
    const lowest = Math.min(...cached, mark.lastUid + 1);
    const owed = server.inbox.messages
      .map(({ uid }) => uid)
      .filter(uid => uid <= mark.lastUid && (mark.complete || uid >= lowest));
    expect(owed.filter(uid => !cached.has(uid))).toEqual([]);
  };

  it('lays the newer list over the old one: new mail, mail gone since and flags', async () => {
    const { server, phone, restore } = await staleWorld([1, 2, 3], server => {
      expunge(server, uid => uid === 2);
      server.inbox.messages = server.inbox.messages.map(message =>
        message.uid === 3 ? { ...message, flags: ['\\Seen'] } : message,
      );
      deliver(server, [4, 5]);
    });

    expect(await restore()).toBe(true);
    // Before any sync of the phone's.
    expect(await uidsOf(phone)).toEqual([1, 3, 4, 5]);
    const read = (await phone.folder('inbox').listSummaries()).find(({ uid }) => uid === 3);
    expect(read?.flags).toEqual(['\\Seen']);
    expect((await phone.folder('inbox').getSync())?.lastUid).toBe(5);
    await expectNoHiddenMail(phone, server);
  });

  it.each<[string, (server: Server) => void]>([
    ['older', server => deliver(server, [4])],
    ['no newer', () => {}],
  ])('leaves the cache alone when the snapshot is %s', async (_label, later) => {
    const { server, phone, restore } = await staleWorld([1, 2, 3], () => {}, later);
    // The phone has caught up past the snapshot meanwhile, and filed mail the snapshot still lists.
    await syncMailbox(server.run, phone);
    await phone.folder('inbox').deleteSummaries([1]);
    const before = await phone.folder('inbox').listSummaries();

    expect(await restore()).toBe(false);
    expect(await phone.folder('inbox').listSummaries()).toEqual(before);
  });

  it('leaves the cache alone when the snapshot is of another login', async () => {
    const { phone, restore } = await staleWorld([1, 2], server => deliver(server, [3]));
    const moved = { ...MAILBOX, imap: { ...MAILBOX.imap, username: 'other@x.co' } };
    expect(await restore({ mailbox: moved })).toBe(false);
    expect(await uidsOf(phone)).toEqual([1, 2]);
  });

  it('leaves a folder renumbered since to the sync, whose uids name other mail', async () => {
    const { server, phone, restore } = await staleWorld([1, 2], server => {
      server.inbox.uidValidity = 8;
      server.inbox.messages = [5, 6, 7].map(uid => ({ uid, flags: [] }));
    });

    expect(await restore()).toBe(false);
    expect(await uidsOf(phone)).toEqual([1, 2]);
    expect((await phone.folder('inbox').getSync())?.uidValidity).toBe(7);
    await syncMailbox(server.run, phone);
    expect(await uidsOf(phone)).toEqual([5, 6, 7]);
  });

  it('keeps the older pages below a window that reaches its mark, and their completeness', async () => {
    // The phone holds the whole folder; the laptop's window is the newest 200.
    const { server, phone, restore } = await staleWorld(range(1, 150), server => {
      expunge(server, uid => uid === 100);
      deliver(server, range(151, 260));
    });

    expect(await restore()).toBe(true);
    expect(await uidsOf(phone)).toEqual(range(1, 260).filter(uid => uid !== 100));
    expect(await phone.folder('inbox').getSync()).toMatchObject({ lastUid: 260, complete: true });
    await expectNoHiddenMail(phone, server);
  });

  it('takes the completeness of a snapshot that reaches the folder start', async () => {
    const { server, phone, restore } = await staleWorld(range(1, 250), server => {
      expunge(server, uid => uid <= 100);
      deliver(server, range(251, 260));
    });
    expect((await phone.folder('inbox').getSync())?.complete).toBe(false);

    expect(await restore()).toBe(true);
    expect(await uidsOf(phone)).toEqual(range(101, 260));
    expect((await phone.folder('inbox').getSync())?.complete).toBe(true);
    await expectNoHiddenMail(phone, server);
  });

  it('starts the folder over from a window that does not reach its mark', async () => {
    // 250 new: the laptop's window starts above the phone's newest, so neither holds 151 to 200.
    const { server, phone, restore } = await staleWorld(range(1, 150), server =>
      deliver(server, range(151, 400)),
    );

    expect(await restore()).toBe(true);
    expect(await uidsOf(phone)).toEqual(range(201, 400));
    expect((await phone.folder('inbox').getSync())?.complete).toBe(false);
    await expectNoHiddenMail(phone, server);
  });

  it('leaves no mark over mail it lacks when a merge is cut short', async () => {
    const { server, phone, restore } = await staleWorld(
      range(1, 150),
      server => deliver(server, range(151, 400)),
      // Most of what arrived goes again, so the sync's window reaches back past the phone's mark.
      server => expunge(server, uid => uid > 200 && uid <= 380),
    );
    const failing: MailCache = {
      ...phone,
      folder: folder => ({
        ...phone.folder(folder),
        putSummaries: async () => {
          throw new Error('the disk is full');
        },
      }),
    };

    expect(await restore({ cache: failing })).toBe(false);
    await syncMailbox(server.run, phone);
    await expectNoHiddenMail(phone, server);
  });

  it("writes no mark once a lock clears the cache during a folder's summaries", async () => {
    const { phone, restore } = await staleWorld([1, 2], server => deliver(server, [3]));
    let isLocked = false;
    const locking: MailCache = {
      ...phone,
      folder: folder => ({
        ...phone.folder(folder),
        putSummaries: async summaries => {
          await phone.folder(folder).putSummaries(summaries);
          isLocked = true;
          await phone.clear();
        },
      }),
    };

    expect(await restore({ cache: locking, isStale: () => isLocked })).toBe(false);
    expect(await phone.folder('inbox').getSync()).toBeNull();
  });

  it('downloads a snapshot once: one taken in, or written here, is not fetched again', async () => {
    const { server, phone, records, files, filesGet, restore } = await staleWorld([1, 2], server =>
      deliver(server, [3]),
    );
    expect(await restore()).toBe(true);
    expect(await restore()).toBe(false);
    expect(filesGet).toHaveBeenCalledOnce();

    // The phone writes the next one itself.
    deliver(server, [4]);
    await syncMailbox(server.run, phone);
    const writer = createSnapshotWriter({
      store: records.store,
      files: files.store,
      now: () => Date.now() + SNAPSHOT_INTERVAL_MS,
    });
    expect(await writer.save(MAILBOX, phone)).toBe('saved');
    expect(await restore()).toBe(false);
    expect(filesGet).toHaveBeenCalledOnce();
  });

  it('does not write back a list it took in unchanged, whatever order its store keeps', async () => {
    const { records, files } = await savedWorld(fakeServer({ uidValidity: 7, uids: [1, 2, 3, 4] }));
    const phone = memoryMailCache();
    await phone.folder('inbox').putSummaries([summary(3, 3), summary(1, 1), summary(2, 2)]);
    await phone
      .folder('inbox')
      .putSync({ name: 'INBOX', uidValidity: 7, lastUid: 3, complete: true });
    expect(
      await restoreSnapshot({
        records: listSnapshotRecords(records.store),
        files: files.store,
        cache: phone,
        mailbox: MAILBOX,
      }),
    ).toBe(true);

    const writer = createSnapshotWriter({
      store: records.store,
      files: files.store,
      now: () => Date.now() + SNAPSHOT_INTERVAL_MS,
    });
    expect(await writer.save(MAILBOX, phone)).toBe('skipped');
  });

  it('shows its own list when the snapshot is slow, and drops the snapshot when it lands', async () => {
    const { phone, files, restore } = await staleWorld([1, 2], server => deliver(server, [3]));
    const arrived = Promise.withResolvers<void>();
    const slow: FileStore = {
      ...files.store,
      get: async fileId => {
        await arrived.promise;
        return files.store.get(fileId);
      },
    };

    expect(await restore({ files: slow, waitMs: 5 })).toBe(false);
    arrived.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await uidsOf(phone)).toEqual([1, 2]);
  });

  it('waits past that for a device with no cache, which has nothing else to show', async () => {
    const server = fakeServer({ uidValidity: 7, uids: [1, 2] });
    const { records, files } = await savedWorld(server);
    const phone = memoryMailCache();
    const slow: FileStore = {
      ...files.store,
      get: async fileId => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return files.store.get(fileId);
      },
    };
    expect(
      await restoreSnapshot({
        records: listSnapshotRecords(records.store),
        files: slow,
        cache: phone,
        mailbox: MAILBOX,
        waitMs: 5,
      }),
    ).toBe(true);
    expect(await uidsOf(phone)).toEqual([1, 2]);
  });

  it('waits for the record within the same bound as the file', async () => {
    const { phone, restore } = await staleWorld([1, 2], server => deliver(server, [3]));
    expect(await restore({ records: new Promise(() => {}), waitMs: 5 })).toBe(false);
    expect(await uidsOf(phone)).toEqual([1, 2]);
  });

  it('asks the vault for every record in one list, not one request per mailbox', async () => {
    const { records } = await staleWorld([1, 2], server => deliver(server, [3]));
    const get = vi.spyOn(records.store, 'get');
    const list = vi.spyOn(records.store, 'list');
    const listed = listSnapshotRecords(records.store);
    const phones = [memoryMailCache(), memoryMailCache()];
    await Promise.all(
      phones.map(cache =>
        restoreSnapshot({ records: listed, files: fakeFileStore().store, cache, mailbox: MAILBOX }),
      ),
    );
    expect(list).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps a copy this device filed above the snapshot’s mark, for the sync to read again', async () => {
    const { server, phone, restore } = await staleWorld([1, 2, 3], server => deliver(server, [4]));
    // A move filed a copy here (`recordMoves`) at a uid the snapshot's device has not seen.
    deliver(server, [5]);
    await phone.folder('inbox').putSummaries([summary(5, 5)]);

    expect(await restore()).toBe(true);
    expect(await uidsOf(phone)).toEqual([1, 2, 3, 4, 5]);
    await syncMailbox(server.run, phone);
    expect(await uidsOf(phone)).toEqual([1, 2, 3, 4, 5]);
  });

  it('claims attachment names only for summaries that carry them', async () => {
    /** A phone whose cache predates attachment names, holding the whole folder. */
    const withoutNames = async (cache: MailCache) => {
      const mark = await cache.folder('inbox').getSync();
      if (mark === null) throw new Error('no mark');
      const { name, uidValidity, lastUid, complete } = mark;
      await cache.folder('inbox').putSync({ name, uidValidity, lastUid, complete });
    };
    // Its older pages are kept: they still want their names read once.
    const kept = await staleWorld(range(1, 150), server => deliver(server, range(151, 260)));
    await withoutNames(kept.phone);
    expect(await kept.restore()).toBe(true);
    expect((await kept.phone.folder('inbox').getSync())?.hasAttachmentNames).toBe(false);

    // Nothing of its own is kept: every summary is the snapshot's, names and all.
    const replaced = await staleWorld(range(1, 150), server => deliver(server, range(151, 400)));
    await withoutNames(replaced.phone);
    expect(await replaced.restore()).toBe(true);
    expect((await replaced.phone.folder('inbox').getSync())?.hasAttachmentNames).toBe(true);
  });

  it('leaves a small folder whose merge was cut short complete after its next sync', async () => {
    const { server, phone, restore } = await staleWorld([1, 2, 3], server => deliver(server, [4]));
    const failing: MailCache = {
      ...phone,
      folder: folder => ({
        ...phone.folder(folder),
        putSummaries: async () => {
          throw new Error('the disk is full');
        },
      }),
    };

    expect(await restore({ cache: failing })).toBe(false);
    await syncMailbox(server.run, phone);
    expect(await uidsOf(phone)).toEqual([1, 2, 3, 4]);
    expect((await phone.folder('inbox').getSync())?.complete).toBe(true);
  });

  it('syncs on from the merge: new mail, mail gone since and the older pages it kept', async () => {
    const { server, phone, restore } = await staleWorld(
      range(1, 150),
      server => deliver(server, range(151, 260)),
      server => {
        expunge(server, uid => uid === 20 || uid === 255);
        deliver(server, [261, 262]);
      },
    );
    expect(await restore()).toBe(true);
    server.fetchSummariesBySeq.mockClear();

    const { state } = await syncMailbox(server.run, phone);
    expect(state.status).toBe('synced');
    expect(await uidsOf(phone)).toEqual(range(1, 262).filter(uid => uid !== 20 && uid !== 255));
    // Incremental from the snapshot's mark, with the kept pages' flags read and 20 dropped.
    expect(server.fetchSummariesBySeq).not.toHaveBeenCalled();
    expect(await phone.folder('inbox').getSync()).toMatchObject({ lastUid: 262, complete: true });
    await expectNoHiddenMail(phone, server);
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
        records: listSnapshotRecords(records.store),
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
      records: listSnapshotRecords(records.store),
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

  it('marks its cache as holding what it wrote', async () => {
    const { cache, writer } = await world();
    expect(await writer().save(MAILBOX, cache)).toBe('saved');
    expect(await cache.getSnapshotDigest()).not.toBeNull();
  });

  it('marks nothing once a lock has begun while it wrote', async () => {
    const { cache, records, writer } = await world();
    // The teardown moves the generation first and clears the cache after, so the cache still reads
    // as what was written.
    let isLocked = false;
    const locking: RecordStore = {
      ...records.store,
      put: async input => {
        await records.store.put(input);
        isLocked = true;
      },
    };
    expect(await writer(locking).save(MAILBOX, cache, () => isLocked)).toBe('saved');
    expect(await cache.getSnapshotDigest()).toBeNull();
  });

  it('marks nothing when the cache no longer holds what it wrote', async () => {
    const { server, cache, records, writer } = await world();
    // A clear and part of a rebuild land while the record is written.
    const rebuilding: RecordStore = {
      ...records.store,
      put: async input => {
        await records.store.put(input);
        await cache.clear();
        server.inbox.messages = server.inbox.messages.filter(({ uid }) => uid !== 1);
        await syncMailbox(server.run, cache);
      },
    };
    expect(await writer(rebuilding).save(MAILBOX, cache)).toBe('saved');
    expect(await cache.getSnapshotDigest()).toBeNull();
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
