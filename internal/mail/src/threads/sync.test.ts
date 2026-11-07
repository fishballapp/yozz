import type { ImapMessageSummary } from '@yozz.app/imap';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailClient, MailConnectionFailure, MailTask, Result } from '../connection.ts';
import { signMessage } from '../testing/dkim-signer.ts';
import type { FetchedBody } from './bodies.ts';
import type { FolderSync } from './cache.ts';
import { cachedPreviews } from './hydrate.ts';
import { threadsFromMailboxes } from './summaries.ts';
import { FOLDERS, type Folder } from './thread.ts';

const list = vi.fn();
const select = vi.fn();
const ensureSelected = vi.fn();
const fetchSummaries = vi.fn();
const fetchSummariesBySeq = vi.fn();
const fetchFlags = vi.fn();
const fetchAttachmentNames = vi.fn();
const fetchRawMessages = vi.fn();
const move = vi.fn();
const storeFlags = vi.fn();
const create = vi.fn();

const fakeClient = {
  list,
  select,
  ensureSelected,
  fetchSummaries,
  fetchSummariesBySeq,
  fetchFlags,
  fetchAttachmentNames,
  fetchRawMessages,
  move,
  storeFlags,
  create,
} as unknown as MailClient;

const noKeys = async () => [];

const run = <T>(task: MailTask<T>): Promise<Result<T, MailConnectionFailure>> =>
  task.run(fakeClient);

const { syncMailbox, loadOlder, prefetchBodies, moveMessages, setFlag } = await import('./sync.ts');

const SENT = { name: 'Sent', delimiter: '/', attributes: ['\\Sent'] };
const ARCHIVE = { name: 'Archive', delimiter: '/', attributes: ['\\Archive'] };
const TRASH = { name: 'Deleted Items', delimiter: '/', attributes: [] };
const INBOX_ONLY = [{ name: 'INBOX', delimiter: '/', attributes: [] }];

const summary = (
  uid: number,
  flags: readonly string[] = [],
  size: number | null = 100,
): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags,
  internalDate: `${uid}-Aug-2026 09:00:00 +0000`,
  size,
  envelope: {
    messageId: `<m${uid}@x>`,
    subject: 'Hi',
    inReplyTo: null,
  } as ImapMessageSummary['envelope'],
  references: [],
  gmailThreadId: null,
  attachmentNames: [],
});

type Seed = { sync?: FolderSync; summaries?: ImapMessageSummary[]; bodies?: Map<number, unknown> };

// A minimal in-memory MailCache double.
const emptyFolder = () => ({
  sync: null as FolderSync | null,
  summaries: [] as ImapMessageSummary[],
  bodies: new Map<number, unknown>(),
});

const fakeCache = (seed: Partial<Record<Folder, Seed>> = {}) => {
  const state = Object.fromEntries(
    FOLDERS.map(folder => [
      folder,
      {
        sync: seed[folder]?.sync ?? null,
        summaries: seed[folder]?.summaries ?? [],
        bodies: seed[folder]?.bodies ?? new Map(),
      },
    ]),
  ) as Record<Folder, ReturnType<typeof emptyFolder>>;
  return {
    folder: (folder: Folder) => ({
      getSync: async () => state[folder].sync,
      putSync: async (s: FolderSync) => {
        state[folder].sync = s;
      },
      listSummaries: async () => state[folder].summaries,
      putSummaries: async (s: readonly ImapMessageSummary[]) => {
        const byUid = new Map([...state[folder].summaries, ...s].map(x => [x.uid, x]));
        state[folder].summaries = [...byUid.values()];
      },
      deleteSummaries: async (uids: readonly number[]) => {
        state[folder].summaries = state[folder].summaries.filter(x => !uids.includes(x.uid));
      },
      updateSummaries: async (
        uids: readonly number[],
        update: (summary: ImapMessageSummary) => ImapMessageSummary,
      ) => {
        // A transaction commits after the call returns, as IndexedDB's does.
        await new Promise(resolve => setTimeout(resolve, 0));
        state[folder].summaries = state[folder].summaries.map(x =>
          uids.includes(x.uid) ? update(x) : x,
        );
      },
      getBody: async (uid: number) =>
        (state[folder].bodies.get(uid) as FetchedBody | undefined) ?? null,
      // The double only answers "is a body cached".
      listBodyUids: async () => new Set(state[folder].bodies.keys()),
      listPreviews: async () =>
        [...state[folder].bodies].map(([uid, body]) => ({
          uid,
          paragraphs: (body as FetchedBody).paragraphs,
        })),
      putBody: async (uid: number, body: unknown) => {
        state[folder].bodies.set(uid, body);
      },
    }),
    getSnapshotDigest: async () => null,
    putSnapshotDigest: async () => {},
    clear: async () => {
      for (const folder of ['inbox', 'sent', 'archive', 'trash'] as const) {
        state[folder] = emptyFolder();
      }
    },
    read: (folder: Folder) => state[folder],
  };
};

/** Answers per folder name, so a test can tell the folders apart. */
const selectAnswers = (
  byName: Record<string, { uidValidity: number; uidNext: number; exists: number }>,
) =>
  select.mockImplementation(async (name: string) => {
    const value = byName[name];
    return value === undefined
      ? { ok: false, reason: { kind: 'no', text: `no such mailbox ${name}` } }
      : { ok: true, value };
  });

beforeEach(() => {
  list.mockReset();
  select.mockReset();
  ensureSelected.mockReset();
  fetchSummaries.mockReset();
  fetchSummariesBySeq.mockReset();
  fetchFlags.mockReset();
  fetchAttachmentNames.mockReset();
  fetchRawMessages.mockReset();
  move.mockReset();
  storeFlags.mockReset();
  create.mockReset();
  list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
  fetchAttachmentNames.mockResolvedValue({ ok: true, value: [] });
  ensureSelected.mockImplementation(async (name: string) => select(name));
});

describe('syncMailbox', () => {
  it('reads each folder as its own task, so a click queued meanwhile runs before the next', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, SENT] });
    const order: string[] = [];
    // The live connection's user lane: one task at a time, first in first out.
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(task: MailTask<T>): Promise<Result<T, MailConnectionFailure>> => {
      const result = (async () => {
        await tail;
        return task.run(fakeClient);
      })();
      tail = result;
      return result;
    };
    select.mockImplementation(async (name: string) => {
      order.push(name);
      if (name === 'INBOX') {
        void serial({
          priority: 'user',
          effect: 'write',
          retry: false,
          run: async () => {
            order.push('open a message');
            return { ok: true, value: undefined };
          },
        });
      }
      return { ok: true, value: { uidValidity: 1, uidNext: 1, exists: 0 } };
    });
    const { state } = await syncMailbox(serial, fakeCache());
    expect(state.status).toBe('synced');
    expect(order).toEqual(['INBOX', 'open a message', 'Sent']);
  });

  it('an inbox sync reads INBOX alone: no LIST, no other folder', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, SENT, ARCHIVE] });
    selectAnswers({
      INBOX: { uidValidity: 1, uidNext: 3, exists: 2 },
      Sent: { uidValidity: 1, uidNext: 1, exists: 0 },
    });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(2)] });
    fetchFlags.mockResolvedValue({ ok: true, value: [{ uid: 1, flags: [] }] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 1, complete: true },
        summaries: [summary(1)],
      },
    });
    const onFolder = vi.fn();
    const res = await syncMailbox(run, cache, () => false, onFolder, 'inbox');
    expect(res.scope).toBe('inbox');
    expect(res.state.status).toBe('synced');
    expect(Object.keys(res.byFolder)).toEqual(['inbox']);
    expect(list).not.toHaveBeenCalled();
    expect(select.mock.calls.map(([name]) => name)).toEqual(['INBOX']);
    expect(
      onFolder.mock.calls.at(-1)?.[1].summaries.map(({ uid }: { uid: number }) => uid),
    ).toEqual([1, 2]);
  });

  it('an inbox sync that finds cached mail gone from INBOX reads every folder, where it went', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    selectAnswers({
      INBOX: { uidValidity: 1, uidNext: 3, exists: 1 },
      Archive: { uidValidity: 1, uidNext: 1, exists: 0 },
    });
    // Another client archived uid 1: the flags fetch no longer answers for it.
    fetchFlags.mockResolvedValue({ ok: true, value: [{ uid: 2, flags: [] }] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 2, complete: true },
        summaries: [summary(1), summary(2)],
      },
    });
    const res = await syncMailbox(
      run,
      cache,
      () => false,
      () => {},
      'inbox',
    );
    expect(res.scope).toBe('all');
    expect(select.mock.calls.map(([name]) => name)).toEqual(['INBOX', 'Archive']);
  });

  it('an inbox sync that finds INBOX renumbered reads every folder, whose cache that cleared', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, SENT] });
    selectAnswers({
      INBOX: { uidValidity: 2, uidNext: 1, exists: 0 },
      Sent: { uidValidity: 1, uidNext: 1, exists: 0 },
    });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 1, complete: true },
        summaries: [summary(1)],
      },
    });
    const res = await syncMailbox(
      run,
      cache,
      () => false,
      () => {},
      'inbox',
    );
    expect(res.scope).toBe('all');
    expect(select.mock.calls.map(([name]) => name)).toEqual(['INBOX', 'Sent']);
  });

  it('first sync fetches a window and records the sync mark', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 300, exists: 250 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(150), summary(151)] });
    const cache = fakeCache();
    const { state } = await syncMailbox(run, cache);
    // 250 messages exist, so the window is the newest 200 by sequence number.
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('51:*');
    // A folder the server lacks has nothing older; only the inbox is larger than a window.
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['sent', 'archive', 'trash', 'drafts'],
    });
    // UIDNEXT 300 says every uid below it has been handed out: the mark is caught up to 299.
    expect(cache.read('inbox').sync).toEqual({
      name: 'INBOX',
      uidValidity: 5,
      lastUid: 299,
      complete: false,
      hasAttachmentNames: true,
    });
    // No Sent folder listed.
    expect(select).toHaveBeenCalledTimes(1);
    expect(cache.read('sent').sync).toBeNull();
  });

  it('marks an empty inbox caught up to UIDNEXT, so the next sync asks for nothing', async () => {
    // Inbox zero: every message so far moved away, the next one will be uid 50.
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 50, exists: 0 } });
    const cache = fakeCache();
    await syncMailbox(run, cache);
    expect(cache.read('inbox').sync).toMatchObject({ lastUid: 49 });

    await syncMailbox(run, cache);
    expect(fetchSummaries).not.toHaveBeenCalled();

    // Then mail arrives: the incremental sync asks from uid 50 on.
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 51, exists: 1 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(50)] });
    await syncMailbox(run, cache);
    expect(fetchSummaries).toHaveBeenCalledWith('50:*');
    expect(cache.read('inbox').sync).toMatchObject({ lastUid: 50 });
  });

  it('reads a folder smaller than the window whole, and asks nothing of an empty one', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 4, exists: 3 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(1)] });
    const small = fakeCache();
    const { state } = await syncMailbox(run, small);
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('1:*');
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['inbox', 'sent', 'archive', 'trash', 'drafts'],
    });
    expect(small.read('inbox').sync?.complete).toBe(true);

    fetchSummariesBySeq.mockClear();
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 1, exists: 0 } });
    const empty = fakeCache();
    const { state: emptyState } = await syncMailbox(run, empty);
    expect(fetchSummariesBySeq).not.toHaveBeenCalled();
    expect(emptyState).toMatchObject({
      status: 'synced',
      complete: ['inbox', 'sent', 'archive', 'trash', 'drafts'],
    });
  });

  it('incremental sync refreshes known flags, drops expunged, and fetches above lastUid', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 12, exists: 2 } });
    fetchFlags.mockResolvedValue({ ok: true, value: [{ uid: 10, flags: ['\\Seen'] }] });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(11)] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 10, complete: true },
        summaries: [summary(9), summary(10)],
      },
    });
    await syncMailbox(run, cache);
    expect(fetchFlags).toHaveBeenCalledWith('9:10');
    expect(fetchSummaries).toHaveBeenCalledWith('11:*');
    const { summaries, sync } = cache.read('inbox');
    // uid 9 was not in the flags refresh, so expunged; 10 kept with new flags; 11 added.
    expect(summaries.map(s => s.uid).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(summaries.find(s => s.uid === 10)?.flags).toEqual(['\\Seen']);
    expect(sync?.lastUid).toBe(11);
    // An incremental sync says nothing about how far back the cache goes.
    expect(sync?.complete).toBe(true);
  });

  it('an incremental sync of a folder that is empty now marks it complete', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 11, exists: 0 } });
    fetchFlags.mockResolvedValue({ ok: true, value: [] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 10, complete: false },
        summaries: [summary(9), summary(10)],
      },
    });
    const { state } = await syncMailbox(run, cache);
    expect(cache.read('inbox').summaries).toEqual([]);
    expect(cache.read('inbox').sync?.complete).toBe(true);
    expect(state).toMatchObject({ status: 'synced', complete: expect.arrayContaining(['inbox']) });
  });

  it('syncs the Sent folder LIST names after the inbox, under its own mark and uid space', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, SENT] });
    selectAnswers({
      INBOX: { uidValidity: 5, uidNext: 3, exists: 1 },
      Sent: { uidValidity: 8, uidNext: 3, exists: 1 },
    });
    fetchSummariesBySeq
      .mockResolvedValueOnce({ ok: true, value: [summary(2)] })
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            ...summary(2),
            envelope: {
              messageId: '<reply@x>',
              subject: 'Re: Hi',
              inReplyTo: '<m2@x>',
            } as ImapMessageSummary['envelope'],
          },
        ],
      });
    const cache = fakeCache();
    const { byFolder, state } = await syncMailbox(run, cache);
    // Grouping is the store's one global pass, run here over the one mailbox synced.
    const threads = threadsFromMailboxes({ 'me@x': byFolder });
    expect(select.mock.calls.map(([name]) => name)).toEqual(['INBOX', 'Sent']);
    expect(cache.read('sent').sync).toEqual({
      name: 'Sent',
      uidValidity: 8,
      lastUid: 2,
      complete: true,
      hasAttachmentNames: true,
    });
    // Both folders were read whole.
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['inbox', 'sent', 'archive', 'trash', 'drafts'],
    });
    // One conversation across the inbox message and the reply.
    expect(threads.map(t => t.messages.map(m => m.id))).toEqual([['mid/<m2@x>', 'mid/<reply@x>']]);
    // Two folders, two uid spaces, each copy carrying its own folder's UIDVALIDITY.
    expect(threads[0]?.messages.map(m => m.locations?.[0])).toEqual([
      { mailbox: 'me@x', folder: 'inbox', uidValidity: 5, uid: 2 },
      { mailbox: 'me@x', folder: 'sent', uidValidity: 8, uid: 2 },
    ]);
  });

  it('a UIDVALIDITY change clears the cache and reports invalidated on the failed refetch', async () => {
    selectAnswers({ INBOX: { uidValidity: 9, uidNext: 50, exists: 45 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: false, reason: { kind: 'bad', text: 'nope' } });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 40, complete: false },
        summaries: [summary(40)],
      },
    });
    const { state } = await syncMailbox(run, cache);
    expect(cache.read('inbox').summaries).toEqual([]);
    expect(state).toMatchObject({ status: 'failed', invalidated: true });
  });

  it('skips every cache write when isStale reports the sync was superseded', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 300, exists: 250 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(150)] });
    const cache = fakeCache();
    const { state } = await syncMailbox(run, cache, () => true);
    expect(state.status).toBe('failed');
    expect(cache.read('inbox')).toEqual({ sync: null, summaries: [], bodies: new Map() });
  });
});

describe('catching up a stale device', () => {
  const uids = (summaries: readonly ImapMessageSummary[]) =>
    summaries.map(s => s.uid).toSorted((a, b) => a - b);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => summary(from + i));

  it('syncs the inbox before LIST, so it needs one command less to show', async () => {
    const order: string[] = [];
    list.mockImplementation(async () => {
      order.push('LIST');
      return { ok: true, value: INBOX_ONLY };
    });
    select.mockImplementation(async (name: string) => {
      order.push(name);
      return { ok: true, value: { uidValidity: 1, uidNext: 1, exists: 0 } };
    });
    await syncMailbox(run, fakeCache());
    expect(order).toEqual(['INBOX', 'LIST']);
  });

  it('hands each folder over as it lands, so a later failure keeps the inbox', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, SENT] });
    selectAnswers({
      INBOX: { uidValidity: 5, uidNext: 3, exists: 1 },
      Sent: { uidValidity: 8, uidNext: 3, exists: 1 },
    });
    fetchSummariesBySeq
      .mockResolvedValueOnce({ ok: true, value: [summary(2)] })
      .mockResolvedValueOnce({ ok: false, reason: { kind: 'closed' } });
    const landed: [Folder, number, number[]][] = [];
    const { state } = await syncMailbox(run, fakeCache(), undefined, (folder, read) =>
      landed.push([folder, read.uidValidity, uids(read.summaries)]),
    );
    expect(state.status).toBe('failed');
    expect(landed).toEqual([['inbox', 5, [2]]]);
  });

  it('shows new mail before the flags of what was cached, then again with them', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 12, exists: 2 } });
    const order: string[] = [];
    fetchSummaries.mockImplementation(async () => {
      order.push('new mail');
      return { ok: true, value: [summary(11)] };
    });
    fetchFlags.mockImplementation(async () => {
      order.push('flags');
      return { ok: true, value: [{ uid: 10, flags: ['\\Seen'] }] };
    });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 10, complete: true },
        summaries: [summary(10)],
      },
    });
    await syncMailbox(run, cache, undefined, (_folder, read) => {
      order.push(
        `landed ${read.summaries.map(s => `${s.uid}${s.flags.length > 0 ? ' seen' : ''}`).join(', ')}`,
      );
    });
    expect(order).toEqual(['new mail', 'landed 10, 11', 'flags', 'landed 10 seen, 11']);
  });

  it('hands over a copy filed above the mark once, as the server just read it', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 12, exists: 2 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(11, ['\\Seen'])] });
    fetchFlags.mockResolvedValue({ ok: true, value: [{ uid: 10, flags: [] }] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 10, complete: true },
        // 11 was filed here by `recordMoves` before any sync of this folder read it.
        summaries: [summary(10), summary(11)],
      },
    });
    const landed: ImapMessageSummary[][] = [];
    await syncMailbox(run, cache, undefined, (_folder, read) => landed.push([...read.summaries]));
    // Flags are refreshed up to the mark; the copy above it is new mail, read with the rest.
    expect(fetchFlags).toHaveBeenCalledWith('10:10');
    expect(landed.map(summaries => summaries.map(s => [s.uid, s.flags]))).toEqual([
      [
        [10, []],
        [11, ['\\Seen']],
      ],
      [
        [10, []],
        [11, ['\\Seen']],
      ],
    ]);
  });

  it('reads a copy filed into a folder that was empty as new mail, asking no flags for an empty range', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 2, exists: 1 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(1)] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 0, complete: true },
        // 1 was filed here by `recordMoves`; the folder had nothing when it last synced.
        summaries: [summary(1)],
      },
    });
    const result = await syncMailbox(run, cache);
    expect(fetchFlags).not.toHaveBeenCalled();
    expect(fetchSummaries).toHaveBeenCalledWith('1:*');
    expect(uids(result.byFolder.inbox?.summaries ?? [])).toEqual([1]);
    expect(uids(cache.read('inbox').summaries)).toEqual([1]);
  });

  it('hands over nothing once the sync is superseded', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 12, exists: 2 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [summary(11)] });
    fetchFlags.mockResolvedValue({ ok: true, value: [{ uid: 10, flags: [] }] });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 10, complete: true },
        summaries: [summary(10)],
      },
    });
    const onFolder = vi.fn();
    await syncMailbox(run, cache, () => true, onFolder);
    expect(onFolder).not.toHaveBeenCalled();
  });

  it('reads a gap wider than a window in uids as the newest window, and keeps the cache when it reaches the mark', async () => {
    // Uids 101..400 were handed out since the mark, but most moved away: 150 messages are new.
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 401, exists: 230 } });
    fetchSummariesBySeq.mockResolvedValue({
      ok: true,
      value: [summary(99), summary(100), ...range(251, 400)],
    });
    fetchFlags.mockResolvedValue({
      ok: true,
      value: [98, 99, 100].map(uid => ({ uid, flags: [] })),
    });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 100, complete: true },
        summaries: [summary(98), summary(99), summary(100)],
      },
    });
    await syncMailbox(run, cache);
    expect(fetchSummaries).not.toHaveBeenCalled();
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('31:*');
    expect(fetchFlags).toHaveBeenCalledWith('98:100');
    const { summaries, sync } = cache.read('inbox');
    expect(uids(summaries)).toEqual([98, 99, 100, ...range(251, 400).map(s => s.uid)]);
    expect(sync).toMatchObject({ lastUid: 400, complete: true });
  });

  it('starts a folder over when more than a window arrived, so the cache never skips mail', async () => {
    // 300 new messages: the newest 200 by sequence number all sit above the mark.
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 401, exists: 303 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: range(201, 400) });
    const cache = fakeCache({
      inbox: {
        sync: {
          name: 'INBOX',
          uidValidity: 5,
          lastUid: 100,
          complete: true,
          hasAttachmentNames: false,
        },
        summaries: [summary(98), summary(99), summary(100)],
        bodies: new Map([[100, { paragraphs: ['kept'] }]]),
      },
    });
    const landed: number[][] = [];
    const { state } = await syncMailbox(run, cache, undefined, (_folder, read) =>
      landed.push(uids(read.summaries)),
    );
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('104:*');
    // Nothing cached is shown or refreshed: it is cut off from the window by mail nobody read.
    expect(fetchFlags).not.toHaveBeenCalled();
    expect(fetchAttachmentNames).not.toHaveBeenCalled();
    expect(landed).toEqual([range(201, 400).map(s => s.uid)]);
    const { summaries, sync, bodies } = cache.read('inbox');
    expect(uids(summaries)).toEqual(range(201, 400).map(s => s.uid));
    expect(sync).toEqual({
      name: 'INBOX',
      uidValidity: 5,
      lastUid: 400,
      complete: false,
      hasAttachmentNames: true,
    });
    // Older mail pages back to it; its body is still good under the same UIDVALIDITY.
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['sent', 'archive', 'trash', 'drafts'],
    });
    expect(bodies.has(100)).toBe(true);
  });

  it('pages back from a fresh start into the mail the gap skipped', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 401, exists: 303 } });
    fetchSummariesBySeq.mockResolvedValueOnce({ ok: true, value: range(201, 400) });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 5, lastUid: 100, complete: true },
        summaries: [summary(100)],
      },
    });
    await syncMailbox(run, cache);

    // uid 201 is sequence 104; the window below it is 1..103, the old mail and the rest of the gap.
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 5 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [{ ...summary(201), seq: 104 }] });
    fetchSummariesBySeq.mockResolvedValueOnce({ ok: true, value: range(98, 200) });
    const res = await loadOlder(run, cache.folder('inbox'));
    expect(fetchSummariesBySeq).toHaveBeenLastCalledWith('1:103');
    expect(res).toEqual({ ok: true, value: { loaded: 103, complete: true } });
    expect(uids(cache.read('inbox').summaries)).toEqual(range(98, 400).map(s => s.uid));
  });
});

describe('the one-time attachment-name upgrade', () => {
  const OLD_MARK = { name: 'INBOX', uidValidity: 5, lastUid: 12, complete: false };
  const body = {
    paragraphs: ['kept'],
    hasTextPart: true,
    inlineImagesTruncated: false,
    attachments: [],
    dkim: null,
  };
  const oldCache = () =>
    fakeCache({
      inbox: {
        sync: OLD_MARK,
        // Below the window's foot there is a gap on the server only: uid 11 was expunged.
        summaries: [summary(10), summary(12)],
        bodies: new Map([[12, body]]),
      },
    });

  beforeEach(() => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 13, exists: 5 } });
    fetchFlags.mockResolvedValue({
      ok: true,
      value: [
        { uid: 10, flags: ['\\Seen'] },
        { uid: 12, flags: [] },
      ],
    });
    fetchAttachmentNames.mockResolvedValue({
      ok: true,
      value: [
        { uid: 10, attachmentNames: ['a.pdf'] },
        { uid: 12, attachmentNames: [] },
      ],
    });
  });

  it('fetches the names over the cached range and merges them, keeping the window and the bodies', async () => {
    const cache = oldCache();
    await syncMailbox(run, cache);

    expect(fetchAttachmentNames).toHaveBeenCalledWith('10:12');
    const { summaries, sync, bodies } = cache.read('inbox');
    expect(summaries.map(({ uid, attachmentNames }) => [uid, attachmentNames])).toEqual([
      [10, ['a.pdf']],
      [12, []],
    ]);
    // Contiguous: nothing was read below the window or above the mark, and its foot has not moved.
    expect(fetchSummaries).not.toHaveBeenCalled();
    expect(fetchSummariesBySeq).not.toHaveBeenCalled();
    expect(sync).toEqual({ ...OLD_MARK, hasAttachmentNames: true });
    expect(bodies.get(12)).toEqual(body);
    // The flags are as the server said; none was written there.
    expect(summaries.find(({ uid }) => uid === 10)?.flags).toEqual(['\\Seen']);
    expect(storeFlags).not.toHaveBeenCalled();
  });

  it('happens once', async () => {
    const cache = oldCache();
    await syncMailbox(run, cache);
    fetchAttachmentNames.mockClear();
    await syncMailbox(run, cache);
    expect(fetchAttachmentNames).not.toHaveBeenCalled();
    expect(cache.read('inbox').summaries.find(({ uid }) => uid === 10)?.attachmentNames).toEqual([
      'a.pdf',
    ]);
  });

  it('leaves the mark as it was when the server fails, so the next sync tries again', async () => {
    fetchAttachmentNames.mockResolvedValue({ ok: false, reason: { kind: 'closed' } });
    const cache = oldCache();
    const { state } = await syncMailbox(run, cache);
    expect(state.status).toBe('failed');
    expect(cache.read('inbox').sync).toEqual(OLD_MARK);
    expect(cache.read('inbox').summaries.map(({ attachmentNames }) => attachmentNames)).toEqual([
      [],
      [],
    ]);
  });

  it('is not needed by a first sync, whose summaries already carry names', async () => {
    fetchSummariesBySeq.mockResolvedValue({
      ok: true,
      value: [{ ...summary(1), attachmentNames: ['b.pdf'] }],
    });
    const cache = fakeCache();
    await syncMailbox(run, cache);
    expect(fetchAttachmentNames).not.toHaveBeenCalled();
    expect(cache.read('inbox').sync?.hasAttachmentNames).toBe(true);
  });
});

describe('loadOlder', () => {
  /** A folder with one page cached, whose oldest message sits at the given sequence number. */
  const paged = (seq: number) => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    fetchSummaries.mockResolvedValue({ ok: true, value: [{ ...summary(40), seq }] });
    return fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 60, complete: false },
        summaries: [summary(40), summary(60)],
      },
    });
  };

  it('fetches the window below the lowest cached uid, by sequence number', async () => {
    const cache = paged(300);
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(7), summary(9)] });
    const res = await loadOlder(run, cache.folder('inbox'));
    expect(ensureSelected).toHaveBeenCalledWith('INBOX');
    // The anchor is the lowest cached uid; its seq is what the window is measured from.
    expect(fetchSummaries).toHaveBeenCalledWith('40');
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('100:299');
    expect(res).toEqual({ ok: true, value: { loaded: 2, complete: false } });
    expect(
      cache
        .read('inbox')
        .summaries.map(s => s.uid)
        .toSorted((a, b) => a - b),
    ).toEqual([7, 9, 40, 60]);
    expect(cache.read('inbox').sync?.complete).toBe(false);
  });

  it('reports complete only when the window reached sequence 1', async () => {
    const cache = paged(120);
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(3)] });
    const res = await loadOlder(run, cache.folder('inbox'));
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('1:119');
    expect(res).toEqual({ ok: true, value: { loaded: 1, complete: true } });
    expect(cache.read('inbox').sync?.complete).toBe(true);

    // Already at the start; marked complete anyway.
    const atStart = paged(1);
    fetchSummariesBySeq.mockClear();
    expect(await loadOlder(run, atStart.folder('inbox'))).toEqual({
      ok: true,
      value: { loaded: 0, complete: true },
    });
    expect(fetchSummariesBySeq).not.toHaveBeenCalled();
    expect(atStart.read('inbox').sync?.complete).toBe(true);
  });

  it('loads nothing when the folder never synced', async () => {
    expect(await loadOlder(run, fakeCache().folder('inbox'))).toEqual({
      ok: true,
      value: { loaded: 0, complete: false },
    });
    expect(ensureSelected).not.toHaveBeenCalled();
  });

  it('writes nothing when isStale reports the load was superseded', async () => {
    const cache = paged(300);
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(7)] });
    const res = await loadOlder(run, cache.folder('inbox'), () => true);
    expect(res.ok).toBe(false);
    expect(cache.read('inbox').summaries.map(s => s.uid)).toEqual([40, 60]);
  });

  describe('a window whose lowest rows moved away before any sync', () => {
    /** Uids 40, 50, 60 cached; the server answers for the ones in `alive` only. */
    const moved = (alive: readonly number[], atSeq: Record<number, number> = {}) => {
      ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
      select.mockResolvedValue({ ok: true, value: { uidValidity: 1, uidNext: 61, exists: 700 } });
      fetchSummaries.mockImplementation(async (set: string) => ({
        ok: true,
        value: alive.includes(Number(set))
          ? [{ ...summary(Number(set)), seq: atSeq[Number(set)] }]
          : [],
      }));
      fetchFlags.mockResolvedValue({
        ok: true,
        value: alive.map(uid => ({ uid, flags: [] })),
      });
      return fakeCache({
        inbox: {
          sync: {
            name: 'INBOX',
            uidValidity: 1,
            lastUid: 60,
            complete: false,
            hasAttachmentNames: true,
          },
          summaries: [summary(40), summary(50), summary(60)],
        },
      });
    };

    it('pages below the lowest cached uid that still answers', async () => {
      const cache = moved([50, 60], { 50: 300 });
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(7), summary(9)] });
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(fetchFlags).toHaveBeenCalledWith('40,50,60');
      expect(fetchSummaries).toHaveBeenLastCalledWith('50');
      expect(fetchSummariesBySeq).toHaveBeenCalledWith('100:299');
      expect(res).toEqual({ ok: true, value: { loaded: 2, complete: false } });
    });

    it('reads the newest page by count when none of them answers', async () => {
      const cache = moved([]);
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(31), summary(32)] });
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(fetchSummariesBySeq).toHaveBeenCalledWith('501:*');
      expect(res).toEqual({ ok: true, value: { loaded: 2, complete: false } });
    });

    it('leaves the rows that moved to the next sync, which drops them and keeps the page', async () => {
      const cache = moved([60], { 60: 300 });
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(7), summary(9)] });
      await loadOlder(run, cache.folder('inbox'));
      expect(
        cache
          .read('inbox')
          .summaries.map(s => s.uid)
          .toSorted((a, b) => a - b),
      ).toEqual([7, 9, 40, 50, 60]);

      list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
      selectAnswers({ INBOX: { uidValidity: 1, uidNext: 61, exists: 3 } });
      fetchFlags.mockResolvedValue({
        ok: true,
        value: [7, 9, 60].map(uid => ({ uid, flags: [] })),
      });
      await syncMailbox(run, cache);
      // The flags pass starts at the page's own lowest uid, so nothing under it is left unchecked.
      expect(fetchFlags).toHaveBeenLastCalledWith('7:60');
      expect(
        cache
          .read('inbox')
          .summaries.map(s => s.uid)
          .toSorted((a, b) => a - b),
      ).toEqual([7, 9, 60]);
    });
  });

  describe('a sync that landed before the task ran', () => {
    it('is read, not the state from before it was queued: no false renumbering', async () => {
      const cache = fakeCache({
        inbox: { sync: { name: 'INBOX', uidValidity: 1, lastUid: 1000, complete: false } },
      });
      select.mockResolvedValue({ ok: true, value: { uidValidity: 2, uidNext: 5, exists: 3 } });
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(3)] });
      const afterSync = <T>(task: MailTask<T>) => {
        void cache
          .folder('inbox')
          .putSync({ name: 'INBOX', uidValidity: 2, lastUid: 4, complete: false });
        return run(task);
      };
      const res = await loadOlder(afterSync, cache.folder('inbox'));
      expect(res).toEqual({ ok: true, value: { loaded: 1, complete: true } });
    });

    it('is read, not the folder as it was when it had never synced', async () => {
      const cache = fakeCache();
      ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
      fetchSummaries.mockResolvedValue({ ok: true, value: [{ ...summary(40), seq: 300 }] });
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(7)] });
      const afterSync = <T>(task: MailTask<T>) => {
        void cache
          .folder('inbox')
          .putSync({ name: 'INBOX', uidValidity: 1, lastUid: 40, complete: false });
        void cache.folder('inbox').putSummaries([summary(40)]);
        return run(task);
      };
      const res = await loadOlder(afterSync, cache.folder('inbox'));
      expect(res).toEqual({ ok: true, value: { loaded: 1, complete: false } });
    });
  });

  describe('a window emptied by triage', () => {
    /** An incomplete folder whose every cached message was filed away; uids 1..lastUid were seen. */
    const emptied = () =>
      fakeCache({
        inbox: { sync: { name: 'INBOX', uidValidity: 1, lastUid: 1000, complete: false } },
      });
    const folderNow = (exists: number, uidValidity = 1) =>
      select.mockResolvedValue({ ok: true, value: { uidValidity, uidNext: 1001, exists } });

    it('reads the newest page the folder still has, by its own count', async () => {
      const cache = emptied();
      folderNow(700);
      // Uids have gaps: what is left of a thousand is 700 messages, not uids 301..1000.
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(310), summary(1000)] });
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(select).toHaveBeenCalledWith('INBOX');
      expect(fetchSummariesBySeq).toHaveBeenCalledWith('501:*');
      expect(fetchSummaries).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, value: { loaded: 2, complete: false } });
      expect(cache.read('inbox').summaries.map(s => s.uid)).toEqual([310, 1000]);
      expect(cache.read('inbox').sync?.complete).toBe(false);
    });

    it('leaves mail that arrived while it read to the next sync', async () => {
      const cache = emptied();
      folderNow(300);
      fetchSummariesBySeq.mockResolvedValue({
        ok: true,
        value: [summary(900), summary(1000), summary(1001), summary(1002)],
      });
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(res).toEqual({ ok: true, value: { loaded: 2, complete: false } });
      expect(cache.read('inbox').summaries.map(s => s.uid)).toEqual([900, 1000]);
      expect(cache.read('inbox').sync?.lastUid).toBe(1000);
    });

    it('is complete when the page reaches the start of the folder', async () => {
      const cache = emptied();
      folderNow(40);
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(5), summary(6)] });
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(fetchSummariesBySeq).toHaveBeenCalledWith('1:*');
      expect(res).toEqual({ ok: true, value: { loaded: 2, complete: true } });
      expect(cache.read('inbox').sync?.complete).toBe(true);
    });

    it('is complete when the folder is empty now', async () => {
      const cache = emptied();
      folderNow(0);
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(fetchSummariesBySeq).not.toHaveBeenCalled();
      expect(res).toEqual({ ok: true, value: { loaded: 0, complete: true } });
      expect(cache.read('inbox').sync?.complete).toBe(true);
    });

    it('writes nothing under a renumbered folder', async () => {
      const cache = emptied();
      folderNow(40, 2);
      const res = await loadOlder(run, cache.folder('inbox'));
      expect(res.ok).toBe(false);
      expect(fetchSummariesBySeq).not.toHaveBeenCalled();
      expect(cache.read('inbox').summaries).toEqual([]);
    });

    it('writes nothing when isStale reports the load was superseded', async () => {
      const cache = emptied();
      folderNow(700);
      fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(310)] });
      const res = await loadOlder(run, cache.folder('inbox'), () => true);
      expect(res.ok).toBe(false);
      expect(cache.read('inbox').summaries).toEqual([]);
    });
  });
});

describe('prefetchBodies', () => {
  const rawOf = (text: string) => new TextEncoder().encode(`Subject: hi\r\n\r\n${text}\r\n`);
  /** Answers every uid asked for, as the uid set names them. */
  const answerEvery = () =>
    fetchRawMessages.mockImplementation(async (set: string) => ({
      ok: true,
      value: set.split(',').flatMap(part => {
        const [first, last = first] = part.split(':').map(Number);
        return Array.from({ length: (last ?? 0) - (first ?? 0) + 1 }, (_, i) => ({
          uid: (first ?? 0) + i,
          bytes: rawOf(`body ${(first ?? 0) + i}`),
        }));
      }),
    }));

  it('fetches the newest under-ceiling uncached bodies in one command', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    answerEvery();
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 4, complete: true },
        summaries: [summary(1), summary(2), summary(3, [], 9_999_999), summary(4)],
        bodies: new Map([[2, { paragraphs: ['cached'] }]]),
      },
    });
    // uid 3 oversized, uid 2 already cached.
    await prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
      noKeys,
    );
    expect(fetchRawMessages.mock.calls).toEqual([['1,4']]);
    expect(ensureSelected).toHaveBeenCalledWith('INBOX');
  });

  it('counts the per-folder budget over eligible bodies, not over the newest uids', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    answerEvery();
    // uids 3 and 4 are already cached; a budget of two must still reach 2 and 1.
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 4, complete: true },
        summaries: [summary(1), summary(2), summary(3), summary(4)],
        bodies: new Map([
          [3, { paragraphs: ['cached'] }],
          [4, { paragraphs: ['cached'] }],
        ]),
      },
    });
    await prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      2,
      noKeys,
    );
    expect(fetchRawMessages.mock.calls).toEqual([['1:2']]);
  });

  it('cuts a command at about a mebibyte of mail', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    answerEvery();
    const half = 600 * 1024;
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 4, complete: true },
        summaries: [summary(1, [], half), summary(2, [], 100), summary(3, [], half), summary(4)],
      },
    });
    await prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
      noKeys,
    );
    // Newest first: 4, 3 and 2 fit in one; 1 would take it past a mebibyte.
    expect(fetchRawMessages.mock.calls).toEqual([['2:4'], ['1']]);
  });

  it('queues the inbox first and leaves Trash and Drafts alone', async () => {
    ensureSelected.mockImplementation(async (name: string) => ({
      ok: true,
      value: { name, uidValidity: 1 },
    }));
    answerEvery();
    const folder = (name: string) => ({
      sync: { name, uidValidity: 1, lastUid: 1, complete: true },
      summaries: [summary(1)],
    });
    const cache = fakeCache({
      inbox: folder('INBOX'),
      sent: folder('Sent'),
      archive: folder('Archive'),
      trash: folder('Trash'),
      drafts: folder('Drafts'),
    });
    const order: string[] = [];
    await prefetchBodies(
      async task => {
        order.push('queued');
        return task.run(fakeClient);
      },
      cache,
      Object.fromEntries(
        FOLDERS.map(name => [name, { uidValidity: 1, summaries: cache.read(name).summaries }]),
      ),
      1024 * 1024,
      30,
      noKeys,
    );
    expect(ensureSelected.mock.calls.map(([name]) => name)).toEqual(['INBOX', 'Sent', 'Archive']);
    expect(order).toHaveLength(3);
  });

  it('skips what another prefetch stored while the batch waited its turn', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    answerEvery();
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 2, complete: true },
        summaries: [summary(1), summary(2)],
      },
    });
    await prefetchBodies(
      async task => {
        // Stored by an earlier prefetch's batch while this one sat in the queue.
        await cache.folder('inbox').putBody(2, { paragraphs: ['stored'] } as FetchedBody);
        return task.run(fakeClient);
      },
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
      noKeys,
    );
    expect(fetchRawMessages.mock.calls).toEqual([['1']]);
  });

  it('fetches nothing from a folder renumbered since the sync', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 2 } });
    answerEvery();
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 1, complete: true },
        summaries: [summary(1)],
      },
    });
    await prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
      noKeys,
    );
    expect(fetchRawMessages).not.toHaveBeenCalled();
  });

  describe('a sender check that waits on DNS', () => {
    /** A message signed by x.example with a key nobody publishes, so a lookup decides what it comes to. */
    const signedRaw = async () => {
      const key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const signed = await signMessage(
        ['From: a@x.example', 'Subject: hi', '', 'body', ''].join('\r\n'),
        {
          key: key.privateKey,
          algorithm: 'ed25519-sha256',
          domain: 'x.example',
          selector: 's',
          headers: ['from', 'subject'],
        },
      );
      return new TextEncoder().encode(signed);
    };
    const inbox = () =>
      fakeCache({
        inbox: {
          sync: { name: 'INBOX', uidValidity: 1, lastUid: 1, complete: true },
          summaries: [summary(1)],
        },
      });
    const prefetchOne = async (
      cache: ReturnType<typeof inbox>,
      lookupTxt: Parameters<typeof prefetchBodies>[5],
      isStale: () => boolean = () => false,
      onBodies: Parameters<typeof prefetchBodies>[7] = () => {},
    ) => {
      ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
      const bytes = await signedRaw();
      fetchRawMessages.mockResolvedValue({ ok: true, value: [{ uid: 1, bytes }] });
      await prefetchBodies(
        run,
        cache,
        { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
        1024 * 1024,
        30,
        lookupTxt,
        isStale,
        onBodies,
      );
    };

    it('writes nothing when the session ends while the check is pending', async () => {
      const cache = inbox();
      const answer = Promise.withResolvers<readonly string[]>();
      let isStale = false;
      const onBodies = vi.fn();
      const prefetching = prefetchOne(
        cache,
        () => {
          // The lock lands while DNS is being asked.
          isStale = true;
          return answer.promise;
        },
        () => isStale,
        onBodies,
      );
      await vi.waitFor(() => expect(isStale).toBe(true));
      answer.resolve([]);
      await prefetching;
      expect(await cache.folder('inbox').getBody(1)).toBeNull();
      expect(onBodies).not.toHaveBeenCalled();
    });

    it('shows a body whose lookup got no answer, and keeps none of it', async () => {
      const cache = inbox();
      const onBodies = vi.fn();
      await prefetchOne(
        cache,
        async () => null,
        () => false,
        onBodies,
      );
      expect(onBodies).toHaveBeenCalledTimes(1);
      expect(onBodies.mock.calls[0]?.[0][0].body).toMatchObject({ dkim: null });
      expect(await cache.folder('inbox').getBody(1)).toBeNull();
    });

    it('keeps a body whose signer has no key: that answer is final', async () => {
      const cache = inbox();
      await prefetchOne(cache, async () => []);
      expect(await cache.folder('inbox').getBody(1)).toMatchObject({ dkim: null });
    });
  });

  it('hands each batch that lands to onBodies at once, and cachedPreviews reads it back', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    answerEvery();
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 2, complete: true },
        summaries: [summary(1), summary(2)],
      },
    });
    const onBodies = vi.fn();
    await prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
      noKeys,
      () => false,
      onBodies,
    );
    expect(onBodies).toHaveBeenCalledTimes(1);
    expect(onBodies.mock.calls[0]?.[0].map(({ at }: { at: unknown }) => at)).toEqual([
      { folder: 'inbox', uidValidity: 1, uid: 1 },
      { folder: 'inbox', uidValidity: 1, uid: 2 },
    ]);
    expect(await cachedPreviews(cache, 'me@x')).toEqual({
      'me@x/inbox/1/1': ['body 1'],
      'me@x/inbox/1/2': ['body 2'],
    });
  });
});

describe('moveMessages', () => {
  /** Moved, with no COPYUID to say where to. */
  const unplaced = (folder: Folder, uids: readonly number[]) =>
    uids.map(uid => ({ from: { folder, uidValidity: 1, uid }, to: null }));

  it('answers where each message went, from the COPYUID, under the destination UIDVALIDITY', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    // `11` went first in the server's answer; `12` was gone before the MOVE reached it.
    move.mockResolvedValue({
      ok: true,
      value: {
        uidValidity: 40,
        source: [
          [11, 11],
          [10, 10],
        ],
        target: [[500, 501]],
      },
    });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [10, 11, 12] }],
      'archive',
    );
    expect(res).toEqual({
      ok: true,
      value: [
        {
          from: { folder: 'inbox', uidValidity: 1, uid: 10 },
          to: { folder: 'archive', uidValidity: 40, uid: 501 },
        },
        {
          from: { folder: 'inbox', uidValidity: 1, uid: 11 },
          to: { folder: 'archive', uidValidity: 40, uid: 500 },
        },
        { from: { folder: 'inbox', uidValidity: 1, uid: 12 }, to: null },
      ],
    });
  });

  it('moves one source as one ranged set, split only past the line budget', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    // Every other uid, so no two make a range: 1,500 of them run past one set's 4096 characters.
    const uids = Array.from({ length: 1500 }, (_, index) => 100_000 + index * 2);
    // Each set lands at its first uid plus 1,000,000, in order.
    move.mockImplementation(async (set: string) => {
      const source = set.split(',').map(uid => [Number(uid), Number(uid)] as const);
      const first = (source[0]?.[0] ?? 0) + 1_000_000;
      return {
        ok: true,
        value: { uidValidity: 40, source, target: [[first, first + source.length - 1]] },
      };
    });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids }],
      'archive',
    );
    const sets = move.mock.calls.map(([set]) => String(set).split(',').map(Number));
    expect(sets.length).toBeGreaterThan(1);
    expect(sets.flat()).toEqual(uids);
    // Each uid's destination is read from the answer to its own set.
    const secondSetStart = sets[1]?.[0] ?? 0;
    expect(
      res.ok ? res.value.find(copy => copy.from.uid === secondSetStart)?.to : undefined,
    ).toEqual({ folder: 'archive', uidValidity: 40, uid: secondSetStart + 1_000_000 });
  });

  it('archives into the LIST \\Archive folder without CREATE', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    move.mockResolvedValue({ ok: true, value: null });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [10, 11] }],
      'archive',
    );
    expect(res).toEqual({ ok: true, value: unplaced('inbox', [10, 11]) });
    expect(ensureSelected).toHaveBeenCalledWith('INBOX');
    expect(move).toHaveBeenCalledWith('10:11', 'Archive');
    expect(create).not.toHaveBeenCalled();
  });

  it('CREATEs Archive when LIST has none, unarchives to INBOX, and maps a refused MOVE', async () => {
    list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    create.mockResolvedValue({ ok: true, value: undefined });
    move.mockResolvedValueOnce({ ok: true, value: null });
    const archived = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [3] }],
      'archive',
    );
    expect(archived).toEqual({ ok: true, value: unplaced('inbox', [3]) });
    expect(create).toHaveBeenCalledWith('Archive');
    expect(move).toHaveBeenCalledWith('3', 'Archive');

    move.mockResolvedValueOnce({ ok: true, value: null });
    const unarchived = await moveMessages(
      run,
      [{ folder: 'archive', folderName: 'Archive', uidValidity: 1, uids: [3] }],
      'inbox',
    );
    expect(unarchived).toEqual({ ok: true, value: unplaced('archive', [3]) });
    expect(move).toHaveBeenLastCalledWith('3', 'INBOX');
    expect(create).toHaveBeenCalledTimes(1);

    move.mockResolvedValueOnce({ ok: false, reason: { kind: 'no', text: 'denied' } });
    const refused = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [4] }],
      'archive',
    );
    expect(refused).toEqual({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'denied' } },
    });
  });

  it('asks LIST again when CREATE is refused, for a folder made since LIST was last read', async () => {
    // The first answer is a remembered one, from before another client made Archive.
    list
      .mockResolvedValueOnce({ ok: true, value: INBOX_ONLY })
      .mockResolvedValueOnce({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    create.mockResolvedValue({ ok: false, reason: { kind: 'no', text: '[ALREADYEXISTS]' } });
    move.mockResolvedValue({ ok: true, value: null });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [3] }],
      'archive',
    );
    expect(res).toEqual({ ok: true, value: unplaced('inbox', [3]) });
    expect(list).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenCalledWith('3', 'Archive');
  });

  it('moves every source folder to Trash in one task, into the Trash folder LIST already names', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, TRASH] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    move.mockResolvedValue({ ok: true, value: null });
    const res = await moveMessages(
      run,
      [
        { folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [1, 2] },
        { folder: 'sent', folderName: 'Sent', uidValidity: 1, uids: [7] },
      ],
      'trash',
    );
    expect(res).toEqual({
      ok: true,
      value: [...unplaced('inbox', [1, 2]), ...unplaced('sent', [7])],
    });
    expect(move.mock.calls).toEqual([
      ['1:2', 'Deleted Items'],
      ['7', 'Deleted Items'],
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to move uids the server has renumbered since they were read', async () => {
    // After a UIDVALIDITY change the same uid names different mail.
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, TRASH] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 9 } });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [1] }],
      'trash',
    );
    expect(res.ok).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it('CREATEs Trash when LIST has no Trash of any name', async () => {
    list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    create.mockResolvedValue({ ok: true, value: undefined });
    move.mockResolvedValue({ ok: true, value: null });
    const res = await moveMessages(
      run,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [8] }],
      'trash',
    );
    expect(res).toEqual({ ok: true, value: unplaced('inbox', [8]) });
    expect(create).toHaveBeenCalledWith('Trash');
    expect(move).toHaveBeenCalledWith('8', 'Trash');
  });
});

describe('setFlag', () => {
  it('writes the flag the server took into the cached summaries, in the same task', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    storeFlags.mockResolvedValue({ ok: true, value: undefined });
    const cache = fakeCache({
      inbox: { summaries: [summary(3, ['\\Seen']), summary(4, ['\\Seen']), summary(5)] },
      archive: { summaries: [summary(9, ['\\seen', '\\Flagged'])] },
    });
    let inboxWhenTaskEnded: unknown;
    const res = await setFlag(
      async task => {
        const result = await task.run(fakeClient);
        inboxWhenTaskEnded = cache.read('inbox').summaries.map(({ uid, flags }) => [uid, flags]);
        return result;
      },
      cache,
      [
        { folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [3, 4] },
        { folder: 'archive', folderName: 'Archive', uidValidity: 1, uids: [9] },
      ],
      '\\Seen',
      false,
    );
    expect(res).toEqual({ ok: true, value: undefined });
    expect(inboxWhenTaskEnded).toEqual([
      [3, []],
      [4, []],
      [5, []],
    ]);
    expect(cache.read('archive').summaries[0]?.flags).toEqual(['\\Flagged']);
  });

  it('writes nothing into the cache when the server refuses the STORE', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    storeFlags.mockResolvedValue({ ok: false, reason: { kind: 'no', text: 'read-only' } });
    const cache = fakeCache({ inbox: { summaries: [summary(3)] } });
    const res = await setFlag(
      run,
      cache,
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [3] }],
      '\\Flagged',
      true,
    );
    expect(res.ok).toBe(false);
    expect(cache.read('inbox').summaries[0]?.flags).toEqual([]);
  });
});

describe('recordMoves', () => {
  it('takes each copy out of its folder and files it where COPYUID said, under the same UIDVALIDITY', async () => {
    const { recordMoves } = await import('./sync.ts');
    const cache = fakeCache({
      inbox: { summaries: [summary(4), summary(5), summary(6)] },
      archive: { sync: { name: 'Archive', uidValidity: 30, lastUid: 10, complete: true } },
    });
    const complete = await recordMoves(cache, [
      {
        from: { folder: 'inbox', uidValidity: 1, uid: 6 },
        to: { folder: 'archive', uidValidity: 30, uid: 12 },
      },
    ]);
    expect(complete).toEqual({ isComplete: true });
    const partial = await recordMoves(cache, [
      {
        from: { folder: 'inbox', uidValidity: 1, uid: 4 },
        to: { folder: 'archive', uidValidity: 30, uid: 11 },
      },
      // The server did not say where this one went: only a sync can find it.
      { from: { folder: 'inbox', uidValidity: 1, uid: 5 }, to: null },
    ]);
    expect(partial).toEqual({ isComplete: false });
    expect(cache.read('inbox').summaries).toEqual([]);
    expect(cache.read('archive').summaries).toEqual([
      { ...summary(6), uid: 12 },
      { ...summary(4), uid: 11 },
    ]);
  });

  it('files nothing in a folder that has not synced, or that was renumbered', async () => {
    const { recordMoves } = await import('./sync.ts');
    const cache = fakeCache({
      inbox: { summaries: [summary(4)] },
      archive: { sync: { name: 'Archive', uidValidity: 31, lastUid: 10, complete: true } },
    });
    expect(
      await recordMoves(cache, [
        {
          from: { folder: 'inbox', uidValidity: 1, uid: 4 },
          to: { folder: 'archive', uidValidity: 30, uid: 11 },
        },
      ]),
    ).toEqual({ isComplete: false });
    expect(
      await recordMoves(cache, [
        {
          from: { folder: 'inbox', uidValidity: 1, uid: 4 },
          to: { folder: 'trash', uidValidity: 30, uid: 11 },
        },
      ]),
    ).toEqual({ isComplete: true });
    expect(cache.read('inbox').summaries).toEqual([]);
    expect(cache.read('archive').summaries).toEqual([]);
    expect(cache.read('trash').summaries).toEqual([]);
  });
});
