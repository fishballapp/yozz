import type { ImapMessageSummary } from '@yozz.app/imap';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDERS, type Folder } from '../lib/thread';
import type { FetchedBody } from './bodies';
import type { FolderSync } from './cache';
import type { MailConnectionFailure, Result } from './connection';
import type { LiveClient, LiveTask } from './live';
import { threadsFromAccounts } from './summaries';

const list = vi.fn();
const select = vi.fn();
const ensureSelected = vi.fn();
const fetchSummaries = vi.fn();
const fetchSummariesBySeq = vi.fn();
const fetchFlags = vi.fn();
const fetchRaw = vi.fn();
const move = vi.fn();
const create = vi.fn();

const fakeClient = {
  list,
  select,
  ensureSelected,
  fetchSummaries,
  fetchSummariesBySeq,
  fetchFlags,
  fetchRaw,
  move,
  create,
} as unknown as LiveClient;

const run = <T>(task: LiveTask<T>): Promise<Result<T, MailConnectionFailure>> =>
  task.run(fakeClient);

const { syncAccount, loadOlder, prefetchBodies, moveThread } = await import('./sync');

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
      // The double only answers "is a body cached"; the seeded shape is never read back.
      getBody: async (uid: number) =>
        (state[folder].bodies.get(uid) as FetchedBody | undefined) ?? null,
      putBody: async (uid: number, body: unknown) => {
        state[folder].bodies.set(uid, body);
      },
    }),
    clear: async () => {
      for (const folder of ['inbox', 'sent', 'archive', 'trash'] as const) {
        state[folder] = emptyFolder();
      }
    },
    read: (folder: Folder) => state[folder],
  };
};

/** The mocked `select` answers per mailbox name, so a test can tell the folders apart. */
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
  fetchRaw.mockReset();
  move.mockReset();
  create.mockReset();
  list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
  ensureSelected.mockImplementation(async (name: string) => select(name));
});

describe('syncAccount', () => {
  it('first sync fetches a window and records the sync mark', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 300, exists: 250 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(150), summary(151)] });
    const cache = fakeCache();
    const { state } = await syncAccount(run, cache);
    // 250 messages exist, so the window is the newest 200 of them by sequence number.
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('51:*');
    // A folder the server lacks has nothing older; only the inbox, larger than a window, is open.
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['sent', 'archive', 'trash', 'drafts'],
    });
    expect(cache.read('inbox').sync).toEqual({
      name: 'INBOX',
      uidValidity: 5,
      lastUid: 151,
      complete: false,
    });
    // No Sent folder listed: nothing asked of one, nothing stored for one.
    expect(select).toHaveBeenCalledTimes(1);
    expect(cache.read('sent').sync).toBeNull();
  });

  it('reads a folder smaller than the window whole, and asks nothing of an empty one', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 4, exists: 3 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(1)] });
    const small = fakeCache();
    const { state } = await syncAccount(run, small);
    expect(fetchSummariesBySeq).toHaveBeenCalledWith('1:*');
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['inbox', 'sent', 'archive', 'trash', 'drafts'],
    });
    expect(small.read('inbox').sync?.complete).toBe(true);

    fetchSummariesBySeq.mockClear();
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 1, exists: 0 } });
    const empty = fakeCache();
    const { state: emptyState } = await syncAccount(run, empty);
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
    await syncAccount(run, cache);
    expect(fetchFlags).toHaveBeenCalledWith('9:10');
    expect(fetchSummaries).toHaveBeenCalledWith('11:*');
    const { summaries, sync } = cache.read('inbox');
    // uid 9 was not in the flags refresh → expunged; 10 kept with new flags; 11 added.
    expect(summaries.map(s => s.uid).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(summaries.find(s => s.uid === 10)?.flags).toEqual(['\\Seen']);
    expect(sync?.lastUid).toBe(11);
    // An incremental sync says nothing about how far back the cache goes; it keeps that answer.
    expect(sync?.complete).toBe(true);
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
    const { byFolder, state } = await syncAccount(run, cache);
    // Grouping is the store's one global pass, so the sync hands back summaries and this test
    // runs the same pass over the one account it synced.
    const threads = threadsFromAccounts({ 'me@x': byFolder });
    expect(select.mock.calls.map(([name]) => name)).toEqual(['INBOX', 'Sent']);
    expect(cache.read('sent').sync).toEqual({
      name: 'Sent',
      uidValidity: 8,
      lastUid: 2,
      complete: true,
    });
    // One message in each: both folders were read whole, so neither has older mail behind it.
    expect(state).toMatchObject({
      status: 'synced',
      complete: ['inbox', 'sent', 'archive', 'trash', 'drafts'],
    });
    // One conversation: the inbox message and the reply that went out, not two threads.
    expect(threads.map(t => t.messages.map(m => m.id))).toEqual([['mid/<m2@x>', 'mid/<reply@x>']]);
    // Two folders, two uid spaces, and each copy carries the UIDVALIDITY of its own folder.
    expect(threads[0]?.messages.map(m => m.locations?.[0])).toEqual([
      { account: 'me@x', folder: 'inbox', uidValidity: 5, uid: 2 },
      { account: 'me@x', folder: 'sent', uidValidity: 8, uid: 2 },
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
    const { state } = await syncAccount(run, cache);
    expect(cache.read('inbox').summaries).toEqual([]);
    expect(state).toMatchObject({ status: 'failed', invalidated: true });
  });

  it('skips every cache write when isStale reports the sync was superseded', async () => {
    selectAnswers({ INBOX: { uidValidity: 5, uidNext: 300, exists: 250 } });
    fetchSummariesBySeq.mockResolvedValue({ ok: true, value: [summary(150)] });
    const cache = fakeCache();
    const { state } = await syncAccount(run, cache, () => true);
    expect(state.status).toBe('failed');
    expect(cache.read('inbox')).toEqual({ sync: null, summaries: [], bodies: new Map() });
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

    // Already at the start: nothing left to ask for, and the folder is marked complete anyway.
    const atStart = paged(1);
    fetchSummariesBySeq.mockClear();
    expect(await loadOlder(run, atStart.folder('inbox'))).toEqual({
      ok: true,
      value: { loaded: 0, complete: true },
    });
    expect(fetchSummariesBySeq).not.toHaveBeenCalled();
    expect(atStart.read('inbox').sync?.complete).toBe(true);
  });

  it('loads nothing when the anchor was expunged, or when the folder never synced', async () => {
    const cache = paged(300);
    fetchSummaries.mockResolvedValue({ ok: true, value: [] });
    expect(await loadOlder(run, cache.folder('inbox'))).toEqual({
      ok: true,
      value: { loaded: 0, complete: false },
    });
    expect(fetchSummariesBySeq).not.toHaveBeenCalled();

    ensureSelected.mockClear();
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
});

describe('prefetchBodies', () => {
  it('fetches only newest under-ceiling uncached bodies', async () => {
    selectAnswers({ INBOX: { uidValidity: 1, uidNext: 10, exists: 3 } });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nhello\r\n');
    fetchRaw.mockResolvedValue({ ok: true, value: raw });
    const cache = fakeCache({
      inbox: {
        sync: { name: 'INBOX', uidValidity: 1, lastUid: 3, complete: true },
        summaries: [summary(1, [], 100), summary(2, [], 100), summary(3, [], 9_999_999)],
        bodies: new Map([[2, { paragraphs: ['cached'] }]]),
      },
    });
    // uid 3 oversized, uid 2 already cached → only uid 1 is fetched.
    prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      30,
    );
    await vi.waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(1));
    expect(fetchRaw).toHaveBeenCalledWith(1);
    expect(ensureSelected).toHaveBeenCalledWith('INBOX');
  });

  it('counts the per-folder budget over eligible bodies, not over the newest uids', async () => {
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    fetchRaw.mockResolvedValue({
      ok: true,
      value: new TextEncoder().encode('Subject: hi\r\n\r\nhello\r\n'),
    });
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
    prefetchBodies(
      run,
      cache,
      { inbox: { uidValidity: 1, summaries: cache.read('inbox').summaries } },
      1024 * 1024,
      2,
    );
    await vi.waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(2));
    expect(fetchRaw.mock.calls.map(([uid]) => uid)).toEqual([2, 1]);
  });
});

describe('moveThread', () => {
  it('archives into the LIST \\Archive mailbox without CREATE', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, ARCHIVE] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    move.mockResolvedValue({ ok: true, value: undefined });
    const res = await moveThread(
      run,
      [{ mailbox: 'INBOX', uidValidity: 1, uids: [10, 11] }],
      'archive',
    );
    expect(res).toEqual({ ok: true, value: undefined });
    expect(ensureSelected).toHaveBeenCalledWith('INBOX');
    expect(move).toHaveBeenCalledWith('10,11', 'Archive');
    expect(create).not.toHaveBeenCalled();
  });

  it('CREATEs Archive when LIST has none, unarchives to INBOX, and maps a refused MOVE', async () => {
    list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    create.mockResolvedValue({ ok: true, value: undefined });
    move.mockResolvedValueOnce({ ok: true, value: undefined });
    const archived = await moveThread(
      run,
      [{ mailbox: 'INBOX', uidValidity: 1, uids: [3] }],
      'archive',
    );
    expect(archived).toEqual({ ok: true, value: undefined });
    expect(create).toHaveBeenCalledWith('Archive');
    expect(move).toHaveBeenCalledWith('3', 'Archive');

    move.mockResolvedValueOnce({ ok: true, value: undefined });
    const unarchived = await moveThread(
      run,
      [{ mailbox: 'Archive', uidValidity: 1, uids: [3] }],
      'inbox',
    );
    expect(unarchived).toEqual({ ok: true, value: undefined });
    expect(move).toHaveBeenLastCalledWith('3', 'INBOX');
    expect(create).toHaveBeenCalledTimes(1);

    move.mockResolvedValueOnce({ ok: false, reason: { kind: 'no', text: 'denied' } });
    const refused = await moveThread(
      run,
      [{ mailbox: 'INBOX', uidValidity: 1, uids: [4] }],
      'archive',
    );
    expect(refused).toEqual({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'denied' } },
    });
  });

  it('bins every source mailbox in one task, into the trash folder LIST already names', async () => {
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, TRASH] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    move.mockResolvedValue({ ok: true, value: undefined });
    const res = await moveThread(
      run,
      [
        { mailbox: 'INBOX', uidValidity: 1, uids: [1, 2] },
        { mailbox: 'Sent', uidValidity: 1, uids: [7] },
      ],
      'trash',
    );
    expect(res).toEqual({ ok: true, value: undefined });
    expect(move.mock.calls).toEqual([
      ['1,2', 'Deleted Items'],
      ['7', 'Deleted Items'],
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to move uids the server has renumbered since they were read', async () => {
    // The same uid names different mail after a UIDVALIDITY change, so a move aimed at one
    // message would bin a stranger's.
    list.mockResolvedValue({ ok: true, value: [...INBOX_ONLY, TRASH] });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 9 } });
    const res = await moveThread(run, [{ mailbox: 'INBOX', uidValidity: 1, uids: [1] }], 'trash');
    expect(res.ok).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it('CREATEs Trash when LIST has no bin of any name', async () => {
    list.mockResolvedValue({ ok: true, value: INBOX_ONLY });
    ensureSelected.mockResolvedValue({ ok: true, value: { uidValidity: 1 } });
    create.mockResolvedValue({ ok: true, value: undefined });
    move.mockResolvedValue({ ok: true, value: undefined });
    const res = await moveThread(run, [{ mailbox: 'INBOX', uidValidity: 1, uids: [8] }], 'trash');
    expect(res).toEqual({ ok: true, value: undefined });
    expect(create).toHaveBeenCalledWith('Trash');
    expect(move).toHaveBeenCalledWith('8', 'Trash');
  });
});
