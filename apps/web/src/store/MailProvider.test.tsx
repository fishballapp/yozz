// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { movesOffered } from '@yozz.app/mail/threads/reconcile';
import type { FlagTarget } from '@yozz.app/mail/threads/sync';
import type { Folder, ThreadState } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailCache } from '../threads/cache';
import { toast } from '../ui/Toast';
import { MailProvider, useMail } from './MailProvider';

const {
  session,
  live,
  moveMessages,
  prefetchBodies,
  setFlag,
  syncMailbox,
  fetchOpenBodyAt,
  thread,
  shown,
} = vi.hoisted(() => {
  const addresses = ['a@example.com', 'b@example.com'];
  const records = addresses.map(address => {
    const host = { host: `imap.${address}`, port: 993, username: address, password: 'secret' };
    return {
      naturalKey: address,
      plaintext: JSON.stringify({ address, smtp: host, imap: host }),
    };
  });
  return {
    session: {
      userId: 'user',
      files: {},
      store: { list: async (type: string) => (type === 'address' ? records : []) },
    },
    /** What the store told the live manager to call when INBOX changes. */
    live: { onMailboxChanged: (_address: string) => {} },
    moveMessages: vi.fn(),
    prefetchBodies: vi.fn(),
    setFlag: vi.fn(),
    syncMailbox: vi.fn(),
    fetchOpenBodyAt: vi.fn(),
    // One conversation in both mailboxes' inboxes, so a move is one command per mailbox.
    thread: {
      id: 't1',
      mailboxes: addresses,
      subject: 'Lunch',
      isUnread: false,
      isReplied: false,
      isStarred: false,
      folders: ['inbox'],
      foldersByMailbox: Object.fromEntries(addresses.map(address => [address, ['inbox']])),
      messages: [
        {
          id: 'm1',
          fromName: 'Ada',
          fromAddress: 'ada@example.org',
          toAddress: 'a@example.com',
          at: 1,
          body: [],
          locations: addresses.map(mailbox => ({
            mailbox,
            folder: 'inbox',
            uidValidity: 1,
            uid: 7,
          })),
        },
      ],
    } satisfies ThreadState,
    /** What the base threads into: `thread` unless a test names another. */
    shown: { threads: [] as ThreadState[] },
  };
});

vi.mock('../vault/session', () => ({ useVault: () => ({ session }) }));
vi.mock('../ui/chrome', () => ({ isDemo: () => false }));
vi.mock('../relay/connection', () => ({ connectImap: vi.fn() }));
vi.mock('../relay/live', () => ({
  createLiveManager: (deps: { onMailboxChanged: (address: string) => void }) => {
    live.onMailboxChanged = deps.onMailboxChanged;
    return { run: vi.fn(), close: vi.fn(), closeAll: async () => {} };
  },
}));
vi.mock('@yozz.app/mail/threads/sync', () => ({
  syncMailbox,
  prefetchBodies,
  moveMessages,
  setFlag,
}));
vi.mock('@yozz.app/mail/threads/bodies', async importOriginal => ({
  ...(await importOriginal<typeof import('@yozz.app/mail/threads/bodies')>()),
  fetchOpenBodyAt,
}));
vi.mock('@yozz.app/mail/threads/summaries', () => ({
  threadsFromMailboxes: () => (shown.threads.length > 0 ? shown.threads : [thread]),
  withDrafts: (threads: unknown) => threads,
}));

const latest: { mail?: ReturnType<typeof useMail> } = {};
const mail = () => {
  if (latest.mail === undefined) throw new Error('MailProvider has not rendered');
  return latest.mail;
};
const Probe = () => {
  latest.mail = useMail();
  return null;
};

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
  moveMessages.mockReset();
  prefetchBodies.mockReset();
  setFlag.mockReset();
  fetchOpenBodyAt.mockReset();
  shown.threads = [];
  // A sync that never lands, so nothing but the write under test changes the threads.
  syncMailbox.mockReset().mockReturnValue(new Promise(() => {}));
});

const mount = async ({ archiveSynced = true } = {}) => {
  // The inbox each mailbox last synced, which is what a move names its uids against, and the
  // Archive it moves into (UIDVALIDITY 3).
  for (const mailbox of thread.mailboxes) {
    const cache = createMailCache(session.userId, mailbox);
    await cache.clear();
    await cache
      .folder('inbox')
      .putSync({ name: 'INBOX', uidValidity: 1, lastUid: 7, complete: true });
    if (archiveSynced) {
      await cache
        .folder('archive')
        .putSync({ name: 'Archive', uidValidity: 3, lastUid: 7, complete: true });
    }
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () =>
    root.render(
      <MailProvider>
        <Probe />
      </MailProvider>,
    ),
  );
  await vi.waitFor(() => expect(mail().mailboxes).toHaveLength(2));
};

describe('MailProvider move refusals', () => {
  it('reports a move every mailbox refused once, and says in the status line what failed', async () => {
    moveMessages.mockResolvedValue({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'Archive is read-only' } },
    });
    await mount();

    const onRefused = vi.fn();
    await act(async () => {
      expect(mail().toggleArchive('t1', onRefused)).toBe(true);
    });

    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mail().threads[0]?.folders).toEqual(['inbox']));
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/: Archive is read-only$/));
    expect(mail().mailError).toMatch(/^thread not moved · imap\.\S+: Archive is read-only$/);
  });

  it('drops a refusal that lands after its session ended', async () => {
    let answer: (value: unknown) => void = () => {};
    moveMessages.mockReturnValue(
      new Promise(resolve => {
        answer = resolve;
      }),
    );
    await mount();

    const onRefused = vi.fn();
    await act(async () => {
      mail().toggleArchive('t1', onRefused);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalled());

    const root = roots.pop();
    await act(async () => root?.unmount());
    await act(async () =>
      answer({ ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Read-only' } } }),
    );
    expect(onRefused).not.toHaveBeenCalled();
  });
});

/**
 * `thread` held by one mailbox. Vitest 5.0.1 hands the second of two overlapping dynamic imports
 * of a mocked module the real one, and two mailboxes' writes or syncs import `threads/sync` at once.
 */
const showOneMailbox = () => {
  const mailbox = 'a@example.com';
  shown.threads = [
    {
      ...thread,
      mailboxes: [mailbox],
      foldersByMailbox: { [mailbox]: ['inbox'] },
      messages: thread.messages.map(message => ({
        ...message,
        locations: message.locations.filter(location => location.mailbox === mailbox),
      })),
    },
  ];
};

const SYNCED = {
  state: { status: 'synced', at: 0, complete: [] },
  byFolder: {},
  scope: 'all',
};

/** A sync of every mailbox that lands only when the test says. */
const heldSyncs = () => {
  const landings: Array<(result?: object) => void> = [];
  syncMailbox.mockImplementation(
    (_run, _cache, _isStale, _onFolder, scope = 'all') =>
      new Promise(resolve => {
        landings.push(result => resolve(result ?? { ...SYNCED, scope }));
      }),
  );
  return {
    count: () => landings.length,
    /** Each held sync lands as `result`, or as a synced pass of the scope it was asked for. */
    landAll: (result?: object) =>
      act(async () => {
        for (const land of landings.splice(0)) land(result);
      }),
  };
};

/** A UIDPLUS server's answer: each uid is now uid + 100, under the destination's UIDVALIDITY 3. */
const placed = (targets: readonly FlagTarget[], to: Folder) => ({
  ok: true,
  value: targets.flatMap(({ folder, uidValidity, uids }) =>
    uids.map(uid => ({
      from: { folder, uidValidity, uid },
      to: { folder: to, uidValidity: 3, uid: uid + 100 },
    })),
  ),
});

/** A server without UIDPLUS: moved, with nothing said about where to. */
const unplaced = (targets: readonly FlagTarget[]) => ({
  ok: true,
  value: targets.flatMap(({ folder, uidValidity, uids }) =>
    uids.map(uid => ({ from: { folder, uidValidity, uid }, to: null })),
  ),
});

/** Moves into `held` wait for `answer`; any other answers at once, as a UIDPLUS server would. */
const holdMovesInto = (held: Folder, answer: (targets: readonly FlagTarget[]) => unknown) => {
  const answers: Array<() => void> = [];
  moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
    to === held
      ? new Promise(resolve => answers.push(() => resolve(answer(targets))))
      : Promise.resolve(placed(targets, to)),
  );
  return {
    answerAll: () =>
      act(async () => {
        for (const answer of answers.splice(0)) answer();
      }),
  };
};

describe('MailProvider confirmed writes', () => {
  it('keeps a confirmed flag without asking for a sync, through a sync that started before it', async () => {
    const syncs = heldSyncs();
    setFlag.mockResolvedValue({ ok: true, value: undefined });
    showOneMailbox();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));

    await act(async () => {
      expect(mail().toggleStar('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(1));
    // The first syncs read the inbox before the STORE and land after it.
    await syncs.landAll();
    expect(syncMailbox).toHaveBeenCalledTimes(2);
    expect(mail().threads[0]?.isStarred).toBe(true);

    // The next sync that comes anyway read the server after the STORE, and retires the op.
    void mail().sync('a@example.com');
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    await syncs.landAll();
    await vi.waitFor(() => expect(mail().threads[0]?.isStarred).toBe(false));
  });

  it('keeps a confirmed move pending, without asking for a sync, until the next one lands', async () => {
    const syncs = heldSyncs();
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
      Promise.resolve(placed(targets, to)),
    );
    showOneMailbox();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    await act(async () => {
      expect(mail().toggleArchive('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    expect(syncMailbox).toHaveBeenCalledTimes(2);
    expect(mail().threads[0]?.folders).toEqual(['archive']);

    void mail().sync('a@example.com');
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    await syncs.landAll();
    await vi.waitFor(() => expect(mail().threads[0]?.folders).toEqual(['inbox']));
  });

  it.each([
    ['answered', 'archive'],
    ['refused halfway', 'inbox'],
  ])(
    'lets a sync whose folders a move %s between go round again before it lands',
    async (outcome, shown) => {
      const syncs = heldSyncs();
      moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
        Promise.resolve(
          outcome === 'answered'
            ? placed(targets, to)
            : { ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Trash is full' } } },
        ),
      );
      showOneMailbox();
      await mount();
      await vi.waitFor(() => expect(syncs.count()).toBe(2));

      await act(async () => {
        mail().toggleArchive('t1');
      });
      await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
      await syncs.landAll();
      // Not landed: it read the inbox before the move and the archive after, so it goes round. A
      // landing prefetches; only the other mailbox's pass, which no move touched, has.
      await vi.waitFor(() => expect(syncs.count()).toBe(1));
      expect(prefetchBodies).toHaveBeenCalledTimes(1);
      expect(mail().threads[0]?.folders).toEqual([shown]);

      await syncs.landAll();
      await vi.waitFor(() => expect(prefetchBodies).toHaveBeenCalledTimes(2));
      expect(mail().threads[0]?.folders).toEqual(['inbox']);
    },
  );
});

describe('MailProvider new mail', () => {
  /** The scope each sync was asked for, in order. */
  const scopes = () => syncMailbox.mock.calls.map(call => call[4] ?? 'all');

  it('reads the inbox alone on a notice, and every folder while a write waits for a whole pass', async () => {
    const syncs = heldSyncs();
    setFlag.mockResolvedValue({ ok: true, value: undefined });
    showOneMailbox();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    await act(async () => live.onMailboxChanged('a@example.com'));
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    expect(scopes()).toEqual(['all', 'all', 'inbox']);
    await syncs.landAll();
    expect(mail().syncStates['a@example.com']?.status).toBe('synced');

    await act(async () => {
      expect(mail().toggleStar('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(1));
    await act(async () => live.onMailboxChanged('a@example.com'));
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    expect(scopes().at(-1)).toBe('all');
    // That pass retires the write, so the next notice reads the inbox alone again.
    await syncs.landAll();
    await act(async () => live.onMailboxChanged('a@example.com'));
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    expect(scopes().at(-1)).toBe('inbox');
  });

  it('reads every folder after a pass that failed, before React has rendered its failure', async () => {
    const syncs = heldSyncs();
    showOneMailbox();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    await act(async () => live.onMailboxChanged('a@example.com'));
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    // A second notice while the inbox pass runs asks for one more; that pass then fails.
    await act(async () => live.onMailboxChanged('a@example.com'));
    await syncs.landAll({
      state: { status: 'failed', failure: { kind: 'stalled' }, at: 0 },
      byFolder: {},
      scope: 'inbox',
    });
    await vi.waitFor(() => expect(scopes()).toHaveLength(4));
    expect(scopes().at(-1)).toBe('all');
  });

  it('reads every folder on a notice while the last whole pass has not landed', async () => {
    syncMailbox.mockResolvedValue({
      state: { status: 'failed', failure: { kind: 'stalled' }, at: 0 },
      byFolder: {},
      scope: 'all',
    });
    showOneMailbox();
    await mount();
    await vi.waitFor(() => expect(mail().syncStates['a@example.com']?.status).toBe('failed'));

    await act(async () => live.onMailboxChanged('a@example.com'));
    await vi.waitFor(() => expect(scopes()).toHaveLength(3));
    expect(scopes().at(-1)).toBe('all');
  });

  it('shows every excerpt a prefetched batch brings', async () => {
    const syncs = heldSyncs();
    const mailbox = 'a@example.com';
    shown.threads = [
      {
        ...thread,
        mailboxes: [mailbox],
        foldersByMailbox: { [mailbox]: ['inbox'] },
        messages: [7, 8].map(uid => ({
          ...thread.messages[0]!,
          id: `m${uid}`,
          bodyStatus: 'pending' as const,
          locations: [{ mailbox, folder: 'inbox' as const, uidValidity: 1, uid }],
        })),
      },
    ];
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();
    await vi.waitFor(() => expect(prefetchBodies).toHaveBeenCalled());
    const onBodies = prefetchBodies.mock.calls[0]?.[7];
    await act(async () =>
      onBodies(
        [7, 8].map(uid => ({
          at: { folder: 'inbox', uidValidity: 1, uid },
          body: { paragraphs: [`excerpt ${uid}`] },
        })),
      ),
    );
    expect(mail().threads[0]?.messages.map(({ body }) => body)).toEqual([
      ['excerpt 7'],
      ['excerpt 8'],
    ]);
  });
});

describe('MailProvider stacked writes', () => {
  it('moves the copies where the move before it put them, once that one has answered', async () => {
    const archive = holdMovesInto('archive', targets => placed(targets, 'archive'));
    showOneMailbox();
    await mount();

    await act(async () => {
      expect(mail().toggleArchive('t1')).toBe(true);
      expect(mail().trashThread('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    expect(mail().threads[0]?.folders).toEqual(['trash']);

    await archive.answerAll();
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    expect(moveMessages.mock.calls[1]?.slice(1)).toEqual([
      [{ folder: 'archive', folderName: 'Archive', uidValidity: 3, uids: [107] }],
      'trash',
    ]);
    expect(mail().mailError).toBeNull();
  });

  it('writes a flag to the copies a pending move put elsewhere', async () => {
    const archive = holdMovesInto('archive', targets => placed(targets, 'archive'));
    setFlag.mockResolvedValue({ ok: true, value: undefined });
    showOneMailbox();
    await mount();

    await act(async () => {
      mail().toggleArchive('t1');
      mail().toggleStar('t1');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    expect(setFlag).not.toHaveBeenCalled();

    await archive.answerAll();
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(1));
    expect(setFlag.mock.calls[0]?.slice(2)).toEqual([
      [{ folder: 'archive', folderName: 'Archive', uidValidity: 3, uids: [107] }],
      '\\Flagged',
      true,
    ]);
  });

  it('moves the copies from where they were when the move before it was refused', async () => {
    const archive = holdMovesInto('archive', () => ({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'Archive is read-only' } },
    }));
    showOneMailbox();
    await mount();

    await act(async () => {
      mail().toggleArchive('t1');
      mail().trashThread('t1');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    await archive.answerAll();
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    expect(moveMessages.mock.calls[1]?.slice(1)).toEqual([
      [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [7] }],
      'trash',
    ]);
    await vi.waitFor(() => expect(mail().threads[0]?.folders).toEqual(['trash']));
  });

  it.each([
    ['the server did not say where the move put them', { archiveSynced: true, uidPlus: false }],
    ['the move put them in a folder no sync has read', { archiveSynced: false, uidPlus: true }],
  ])('refuses, and asks for a sync, when %s', async (_, { archiveSynced, uidPlus }) => {
    const syncs = heldSyncs();
    const archive = holdMovesInto('archive', targets =>
      uidPlus ? placed(targets, 'archive') : unplaced(targets),
    );
    showOneMailbox();
    await mount({ archiveSynced });
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    const onRefused = vi.fn();
    await act(async () => {
      mail().toggleArchive('t1');
      expect(mail().trashThread('t1', onRefused)).toBe(true);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    await archive.answerAll();
    const pending = 'Still confirming the last move of that conversation; try again in a moment.';
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledWith(pending));
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(moveMessages).toHaveBeenCalledTimes(1);
    expect(mail().mailError).toBe(`thread not moved · ${pending}`);
    expect(mail().threads[0]?.folders).toEqual(['archive']);
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
  });
});

/** A conversation of one message, held in `folder` at `uid` by each of `mailboxes`. */
const conversation = (
  id: string,
  folder: 'inbox' | 'archive',
  uid: number,
  mailboxes: readonly string[] = thread.mailboxes,
): ThreadState => ({
  ...thread,
  id,
  mailboxes: [...mailboxes],
  folders: [folder],
  foldersByMailbox: Object.fromEntries(mailboxes.map(mailbox => [mailbox, [folder]])),
  messages: [
    {
      ...thread.messages[0]!,
      id: `${id}/m`,
      // As `mount` writes the marks: INBOX under UIDVALIDITY 1, Archive under 3.
      locations: mailboxes.map(mailbox => ({
        mailbox,
        folder,
        uidValidity: folder === 'inbox' ? 1 : 3,
        uid,
      })),
    },
  ],
});

describe('MailProvider bulk writes', () => {
  it('moves many threads with one command per mailbox, each naming every folder once', async () => {
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
      Promise.resolve(placed(targets, to)),
    );
    shown.threads = [
      ...[10, 11, 12, 13].map(uid => conversation(`in-${uid}`, 'inbox', uid)),
      ...[20, 21].map(uid => conversation(`ar-${uid}`, 'archive', uid)),
    ];
    await mount();

    const ids = shown.threads.map(({ id }) => id);
    await act(async () => {
      expect(mail().moveThreads(ids, 'trash')).toEqual(new Set(ids));
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    for (const [, targets, to] of moveMessages.mock.calls) {
      expect(to).toBe('trash');
      expect(targets).toEqual([
        { folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [10, 11, 12, 13] },
        { folder: 'archive', folderName: 'Archive', uidValidity: 3, uids: [20, 21] },
      ]);
    }
    expect(mail().threads.map(({ folders }) => folders)).toEqual(ids.map(() => ['trash']));
  });

  it('puts back only what the refusing mailbox held, and reports the batch once', async () => {
    const syncs = heldSyncs();
    const answers = [
      (targets: readonly FlagTarget[]) => placed(targets, 'archive'),
      () => ({ ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'System Error' } } }),
    ];
    moveMessages.mockImplementation(async (_run, targets: readonly FlagTarget[]) =>
      answers.shift()?.(targets),
    );
    shown.threads = [10, 11, 12].map(uid => conversation(`in-${uid}`, 'inbox', uid));
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    const onRefused = vi.fn();
    await act(async () => {
      mail().moveThreads(
        shown.threads.map(({ id }) => id),
        'archive',
        onRefused,
      );
    });
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));
    expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/: System Error$/));
    // One mailbox's copies moved, the other's are back in its inbox, in every thread.
    await vi.waitFor(() =>
      expect(
        mail().threads.map(({ foldersByMailbox }) =>
          Object.values(foldersByMailbox)
            .map(folders => folders.join())
            .toSorted(),
        ),
      ).toEqual(shown.threads.map(() => ['archive', 'inbox'])),
    );
    // The half-done batch asks its mailbox for one sync, not one per thread.
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
  });

  it.each([
    [
      'follows a pending move: the thread goes in the same command, from where that move put it',
      true,
    ],
    [
      'refuses only the thread a pending move left unplaced, and moves the rest in one command',
      false,
    ],
  ])('%s', async (_, uidPlus) => {
    const mailbox = 'a@example.com';
    const archive = holdMovesInto('archive', targets =>
      uidPlus ? placed(targets, 'archive') : unplaced(targets),
    );
    shown.threads = [
      conversation('first', 'inbox', 7, [mailbox]),
      conversation('second', 'inbox', 8, [mailbox]),
    ];
    await mount();

    const onRefused = vi.fn();
    await act(async () => {
      mail().toggleArchive('first');
      mail().moveThreads(['first', 'second'], 'trash', onRefused);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    await archive.answerAll();
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    expect(moveMessages.mock.calls[1]?.slice(1)).toEqual([
      uidPlus
        ? [
            { folder: 'archive', folderName: 'Archive', uidValidity: 3, uids: [107] },
            { folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [8] },
          ]
        : [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [8] }],
      'trash',
    ]);
    if (uidPlus) {
      expect(onRefused).not.toHaveBeenCalled();
    } else {
      expect(onRefused).toHaveBeenCalledTimes(1);
      expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/^Still confirming/));
      expect(mail().threads.find(({ id }) => id === 'first')?.folders).toEqual(['archive']);
      // The rest of the batch landing keeps the refusal in the status line.
      expect(mail().mailError).toMatch(/^thread not moved · Still confirming/);
    }
    expect(mail().threads.find(({ id }) => id === 'second')?.folders).toEqual(['trash']);
  });

  it('writes one flag command per mailbox for many threads', async () => {
    setFlag.mockResolvedValue({ ok: true, value: undefined });
    shown.threads = [10, 11, 12].map(uid => ({
      ...conversation(`in-${uid}`, 'inbox', uid),
      isUnread: true,
    }));
    await mount();

    const ids = shown.threads.map(({ id }) => id);
    await act(async () => {
      expect(mail().flagThreads(ids, 'isUnread', false)).toEqual(new Set(ids));
    });
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(2));
    for (const call of setFlag.mock.calls) {
      expect(call.slice(2)).toEqual([
        [{ folder: 'inbox', folderName: 'INBOX', uidValidity: 1, uids: [10, 11, 12] }],
        '\\Seen',
        true,
      ]);
    }
  });

  it('asks for a sync when a flag write is refused, since a folder before the refusal may have taken it', async () => {
    const syncs = heldSyncs();
    setFlag.mockResolvedValue({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'System Error' } },
    });
    const mailbox = 'a@example.com';
    shown.threads = [
      { ...conversation('in-10', 'inbox', 10, [mailbox]), isUnread: true },
      { ...conversation('ar-20', 'archive', 20, [mailbox]), isUnread: true },
    ];
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    await act(async () => {
      mail().flagThreads(['in-10', 'ar-20'], 'isUnread', false);
    });
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(syncs.count()).toBe(1));
    expect(mail().mailError).toMatch(/^flag not saved · /);
  });
});

describe('MailProvider Junk', () => {
  /** A whole pass that read a Junk folder, or found none to read. */
  const passWith = (hasJunk: boolean) => ({
    ...SYNCED,
    byFolder: hasJunk ? { junk: { uidValidity: 9, summaries: [] } } : {},
  });

  it('offers Junk only once every mailbox holding a copy has said whether it has a Junk folder', async () => {
    const landings: Array<(result: object) => void> = [];
    syncMailbox.mockImplementation(
      () => new Promise(resolve => landings.push(result => resolve(result))),
    );
    await mount();
    await vi.waitFor(() => expect(landings).toHaveLength(2));
    const offered = () => movesOffered(mail().threads[0] ?? thread, mail().junkFolders);

    await act(async () => landings[0]?.(passWith(true)));
    await vi.waitFor(() => expect(Object.values(mail().junkFolders)).toEqual([true]));
    // The other mailbox has not answered: a move now would leave its copy in the inbox unseen.
    expect(offered().canMoveToJunk).toBe(false);

    await act(async () => landings[1]?.(passWith(false)));
    await vi.waitFor(() =>
      expect(Object.values(mail().junkFolders).toSorted()).toEqual([false, true]),
    );
    expect(offered().canMoveToJunk).toBe(true);
  });

  it('moves only the copies a Junk folder can take, then syncs to split the conversation', async () => {
    syncMailbox
      .mockResolvedValueOnce(passWith(true))
      .mockResolvedValueOnce(passWith(false))
      .mockReturnValue(new Promise(() => {}));
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
      Promise.resolve(placed(targets, to)),
    );
    await mount();
    await vi.waitFor(() => expect(Object.keys(mail().junkFolders)).toHaveLength(2));
    const [withJunk] = Object.entries(mail().junkFolders).find(([, has]) => has) ?? [];
    const without = thread.mailboxes.find(address => address !== withJunk);

    await act(async () => {
      expect(mail().moveThreads(['t1'], 'junk')).toEqual(new Set(['t1']));
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    expect(mail().threads[0]?.foldersByMailbox).toEqual({
      [withJunk ?? '']: ['junk'],
      [without ?? '']: ['inbox'],
    });
    // The two first passes, then the one the move asked for.
    await vi.waitFor(() => expect(syncMailbox).toHaveBeenCalledTimes(3));
  });
});

describe('MailProvider opening a moved message', () => {
  it('fetches the body where a move put it, before any sync says so', async () => {
    fetchOpenBodyAt.mockResolvedValue({ ok: false, error: { kind: 'error', detail: 'held' } });
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[], to: Folder) =>
      Promise.resolve(placed(targets, to)),
    );
    shown.threads = [
      { ...thread, messages: thread.messages.map(m => ({ ...m, bodyStatus: 'pending' as const })) },
    ];
    await mount();

    await act(async () => {
      mail().moveThreads(['t1'], 'archive');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    await act(async () => {
      await mail().loadBody('t1', 'm1');
    });
    expect(fetchOpenBodyAt).toHaveBeenCalledTimes(1);
    // `placed` answers each uid as uid + 100 under the destination's UIDVALIDITY 3.
    expect(fetchOpenBodyAt.mock.calls[0]?.[2]).toMatchObject({
      folder: 'archive',
      uidValidity: 3,
      uid: 107,
    });
  });
});

describe('MailProvider opening a message a move took somewhere unsaid', () => {
  const pending = () => {
    shown.threads = [
      { ...thread, messages: thread.messages.map(m => ({ ...m, bodyStatus: 'pending' as const })) },
    ];
  };

  it('says it failed, with a retry, rather than showing nothing', async () => {
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[]) =>
      Promise.resolve(unplaced(targets)),
    );
    pending();
    await mount();
    await act(async () => {
      mail().moveThreads(['t1'], 'archive');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));

    const outcome = await act(async () => mail().loadBody('t1', 'm1'));
    expect(outcome.status).toBe('failed');
    expect(fetchOpenBodyAt).not.toHaveBeenCalled();
    expect(mail().threads[0]?.messages[0]?.bodyStatus).toBe('failed');
    expect(mail().mailError).toContain('message not loaded');
  });

  it('shows the body cached where it was before the move', async () => {
    moveMessages.mockImplementation((_run, targets: readonly FlagTarget[]) =>
      Promise.resolve(unplaced(targets)),
    );
    pending();
    await mount();
    for (const mailbox of thread.mailboxes) {
      await createMailCache(session.userId, mailbox)
        .folder('inbox')
        .putBody(7, {
          paragraphs: ['Lunch at one?'],
          hasTextPart: true,
          htmlSaysMore: false,
          inlineImagesTruncated: false,
          attachments: [],
          unsubscribe: null,
          dkim: null,
        });
    }
    await act(async () => {
      mail().moveThreads(['t1'], 'archive');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));

    const outcome = await act(async () => mail().loadBody('t1', 'm1'));
    expect(outcome).toMatchObject({ status: 'loaded', body: ['Lunch at one?'] });
  });
});

describe('MailProvider ending a session', () => {
  it('takes down every toast, so none waits on screen for whoever unlocks next', async () => {
    await mount();
    const closed = vi.spyOn(toast, 'close');

    const root = roots.pop();
    await act(async () => root?.unmount());
    // No id: every toast, whichever of this session's answers raised it.
    expect(closed).toHaveBeenCalledWith();
    closed.mockRestore();
  });
});
