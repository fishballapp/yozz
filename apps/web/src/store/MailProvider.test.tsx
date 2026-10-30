// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import type { FlagTarget } from '@yozz.app/mail/threads/sync';
import type { Folder, ThreadState } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailCache } from '../threads/cache';
import { toast } from '../ui/Toast';
import { MailProvider, useMail } from './MailProvider';

const { session, moveMessages, prefetchBodies, setFlag, syncAccount, thread, shown } = vi.hoisted(
  () => {
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
        store: { list: async (type: string) => (type === 'address' ? records : []) },
      },
      moveMessages: vi.fn(),
      prefetchBodies: vi.fn(),
      setFlag: vi.fn(),
      syncAccount: vi.fn(),
      // One conversation in both accounts' inboxes, so a move is one command per account.
      thread: {
        id: 't1',
        accounts: addresses,
        subject: 'Lunch',
        isUnread: false,
        isReplied: false,
        isStarred: false,
        folders: ['inbox'],
        foldersByAccount: Object.fromEntries(addresses.map(address => [address, ['inbox']])),
        messages: [
          {
            id: 'm1',
            fromName: 'Ada',
            fromAddress: 'ada@example.org',
            toAddress: 'a@example.com',
            at: 1,
            body: [],
            locations: addresses.map(account => ({
              account,
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
  },
);

vi.mock('../vault/session', () => ({ useVault: () => ({ session }) }));
vi.mock('../ui/chrome', () => ({ isDemo: () => false }));
vi.mock('../relay/connection', () => ({ connectImap: vi.fn() }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({ run: vi.fn(), close: vi.fn(), closeAll: async () => {} }),
}));
vi.mock('@yozz.app/mail/threads/sync', () => ({
  syncAccount,
  prefetchBodies,
  moveMessages,
  setFlag,
}));
vi.mock('@yozz.app/mail/threads/summaries', () => ({
  threadsFromAccounts: () => (shown.threads.length > 0 ? shown.threads : [thread]),
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
  shown.threads = [];
  // A sync that never lands, so nothing but the write under test changes the threads.
  syncAccount.mockReset().mockReturnValue(new Promise(() => {}));
});

const mount = async ({ archiveSynced = true } = {}) => {
  // The inbox each account last synced, which is what a move names its uids against, and the
  // Archive it moves into (UIDVALIDITY 3).
  for (const account of thread.accounts) {
    const cache = createMailCache(session.userId, account);
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
  await vi.waitFor(() => expect(mail().accounts).toHaveLength(2));
};

describe('MailProvider move refusals', () => {
  it('reports a move every account refused once, and says in the status line what failed', async () => {
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
 * `thread` held by one account. Vitest 5.0.1 hands the second of two overlapping dynamic imports
 * of a mocked module the real one, and two accounts' writes or syncs import `threads/sync` at once.
 */
const showOneAccount = () => {
  const account = 'a@example.com';
  shown.threads = [
    {
      ...thread,
      accounts: [account],
      foldersByAccount: { [account]: ['inbox'] },
      messages: thread.messages.map(message => ({
        ...message,
        locations: message.locations.filter(location => location.account === account),
      })),
    },
  ];
};

const SYNCED = { state: { status: 'synced', at: 0, complete: [] }, byFolder: {} };

/** A sync of every account that lands only when the test says. */
const heldSyncs = () => {
  const landings: Array<() => void> = [];
  syncAccount.mockImplementation(
    () =>
      new Promise(resolve => {
        landings.push(() => resolve(SYNCED));
      }),
  );
  return {
    count: () => landings.length,
    landAll: () =>
      act(async () => {
        for (const land of landings.splice(0)) land();
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
    showOneAccount();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));

    await act(async () => {
      expect(mail().toggleStar('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(setFlag).toHaveBeenCalledTimes(1));
    // The first syncs read the inbox before the STORE and land after it.
    await syncs.landAll();
    expect(syncAccount).toHaveBeenCalledTimes(2);
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
    showOneAccount();
    await mount();
    await vi.waitFor(() => expect(syncs.count()).toBe(2));
    await syncs.landAll();

    await act(async () => {
      expect(mail().toggleArchive('t1')).toBe(true);
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    expect(syncAccount).toHaveBeenCalledTimes(2);
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
      showOneAccount();
      await mount();
      await vi.waitFor(() => expect(syncs.count()).toBe(2));

      await act(async () => {
        mail().toggleArchive('t1');
      });
      await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
      await syncs.landAll();
      // Not landed: it read the inbox before the move and the archive after, so it goes round. A
      // landing prefetches; only the other account's pass, which no move touched, has.
      await vi.waitFor(() => expect(syncs.count()).toBe(1));
      expect(prefetchBodies).toHaveBeenCalledTimes(1);
      expect(mail().threads[0]?.folders).toEqual([shown]);

      await syncs.landAll();
      await vi.waitFor(() => expect(prefetchBodies).toHaveBeenCalledTimes(2));
      expect(mail().threads[0]?.folders).toEqual(['inbox']);
    },
  );
});

describe('MailProvider stacked writes', () => {
  it('moves the copies where the move before it put them, once that one has answered', async () => {
    const archive = holdMovesInto('archive', targets => placed(targets, 'archive'));
    showOneAccount();
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
      [{ folder: 'archive', mailbox: 'Archive', uidValidity: 3, uids: [107] }],
      'trash',
    ]);
    expect(mail().mailError).toBeNull();
  });

  it('writes a flag to the copies a pending move put elsewhere', async () => {
    const archive = holdMovesInto('archive', targets => placed(targets, 'archive'));
    setFlag.mockResolvedValue({ ok: true, value: undefined });
    showOneAccount();
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
      [{ folder: 'archive', mailbox: 'Archive', uidValidity: 3, uids: [107] }],
      '\\Flagged',
      true,
    ]);
  });

  it('moves the copies from where they were when the move before it was refused', async () => {
    const archive = holdMovesInto('archive', () => ({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'Archive is read-only' } },
    }));
    showOneAccount();
    await mount();

    await act(async () => {
      mail().toggleArchive('t1');
      mail().trashThread('t1');
    });
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(1));
    await archive.answerAll();
    await vi.waitFor(() => expect(moveMessages).toHaveBeenCalledTimes(2));
    expect(moveMessages.mock.calls[1]?.slice(1)).toEqual([
      [{ folder: 'inbox', mailbox: 'INBOX', uidValidity: 1, uids: [7] }],
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
    showOneAccount();
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

/** A conversation of one message, held in `folder` at `uid` by each of `accounts`. */
const conversation = (
  id: string,
  folder: 'inbox' | 'archive',
  uid: number,
  accounts: readonly string[] = thread.accounts,
): ThreadState => ({
  ...thread,
  id,
  accounts: [...accounts],
  folders: [folder],
  foldersByAccount: Object.fromEntries(accounts.map(account => [account, [folder]])),
  messages: [
    {
      ...thread.messages[0]!,
      id: `${id}/m`,
      // As `mount` writes the marks: INBOX under UIDVALIDITY 1, Archive under 3.
      locations: accounts.map(account => ({
        account,
        folder,
        uidValidity: folder === 'inbox' ? 1 : 3,
        uid,
      })),
    },
  ],
});

describe('MailProvider bulk writes', () => {
  it('moves many threads with one command per account, each naming every folder once', async () => {
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
        { folder: 'inbox', mailbox: 'INBOX', uidValidity: 1, uids: [10, 11, 12, 13] },
        { folder: 'archive', mailbox: 'Archive', uidValidity: 3, uids: [20, 21] },
      ]);
    }
    expect(mail().threads.map(({ folders }) => folders)).toEqual(ids.map(() => ['trash']));
  });

  it('puts back only what the refusing account held, and reports the batch once', async () => {
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
    // One account's copies moved, the other's are back in its inbox, in every thread.
    await vi.waitFor(() =>
      expect(
        mail().threads.map(({ foldersByAccount }) =>
          Object.values(foldersByAccount)
            .map(folders => folders.join())
            .toSorted(),
        ),
      ).toEqual(shown.threads.map(() => ['archive', 'inbox'])),
    );
    // The half-done batch asks its account for one sync, not one per thread.
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
    const account = 'a@example.com';
    const archive = holdMovesInto('archive', targets =>
      uidPlus ? placed(targets, 'archive') : unplaced(targets),
    );
    shown.threads = [
      conversation('first', 'inbox', 7, [account]),
      conversation('second', 'inbox', 8, [account]),
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
            { folder: 'archive', mailbox: 'Archive', uidValidity: 3, uids: [107] },
            { folder: 'inbox', mailbox: 'INBOX', uidValidity: 1, uids: [8] },
          ]
        : [{ folder: 'inbox', mailbox: 'INBOX', uidValidity: 1, uids: [8] }],
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

  it('writes one flag command per account for many threads', async () => {
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
        [{ folder: 'inbox', mailbox: 'INBOX', uidValidity: 1, uids: [10, 11, 12] }],
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
    const account = 'a@example.com';
    shown.threads = [
      { ...conversation('in-10', 'inbox', 10, [account]), isUnread: true },
      { ...conversation('ar-20', 'archive', 20, [account]), isUnread: true },
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
