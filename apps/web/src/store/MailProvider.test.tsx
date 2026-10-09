// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailCache } from '../threads/cache';
import type { ThreadState } from '../threads/thread';
import { toast } from '../ui/Toast';
import { MailProvider, useMail } from './MailProvider';

const { session, moveThread, thread } = vi.hoisted(() => {
  const addresses = ['a@example.com', 'b@example.com'];
  const records = addresses.map(address => {
    const host = { host: `imap.${address}`, port: 993, username: address, password: 'secret' };
    return { naturalKey: address, plaintext: JSON.stringify({ address, smtp: host, imap: host }) };
  });
  return {
    session: {
      userId: 'user',
      store: { list: async (type: string) => (type === 'address' ? records : []) },
    },
    moveThread: vi.fn(),
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
  };
});

vi.mock('../vault/session', () => ({ useVault: () => ({ session }) }));
vi.mock('../ui/chrome', () => ({ isDemo: () => false }));
vi.mock('../relay/connection', () => ({ connectImap: vi.fn() }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({ run: vi.fn(), close: vi.fn(), closeAll: async () => {} }),
}));
// A sync that never lands, so nothing but the move under test changes the threads.
vi.mock('../threads/sync', () => ({
  syncAccount: () => new Promise(() => {}),
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
  moveThread,
}));
vi.mock('../threads/summaries', () => ({
  threadsFromAccounts: () => [thread],
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
  moveThread.mockReset();
});

const mount = async () => {
  // The inbox each account last synced, which is what a move names its uids against.
  for (const account of thread.accounts) {
    await createMailCache(session.userId, account)
      .folder('inbox')
      .putSync({ name: 'INBOX', uidValidity: 1, lastUid: 7, complete: true });
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
    moveThread.mockResolvedValue({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'no', text: 'Archive is read-only' } },
    });
    await mount();

    const onRefused = vi.fn();
    await act(async () => {
      expect(mail().toggleArchive('t1', onRefused)).toBe(true);
    });

    await vi.waitFor(() => expect(moveThread).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mail().threads[0]?.folders).toEqual(['inbox']));
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/: Archive is read-only$/));
    expect(mail().mailError).toMatch(/^thread not moved · imap\.\S+: Archive is read-only$/);
  });

  it('drops a refusal that lands after its session ended', async () => {
    let answer: (value: unknown) => void = () => {};
    moveThread.mockReturnValue(
      new Promise(resolve => {
        answer = resolve;
      }),
    );
    await mount();

    const onRefused = vi.fn();
    await act(async () => {
      mail().toggleArchive('t1', onRefused);
    });
    await vi.waitFor(() => expect(moveThread).toHaveBeenCalled());

    const root = roots.pop();
    await act(async () => root?.unmount());
    await act(async () =>
      answer({ ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Read-only' } } }),
    );
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('refuses a move on the spot while the last one is still being confirmed', async () => {
    moveThread.mockReturnValue(new Promise(() => {}));
    await mount();

    await act(async () => {
      expect(mail().toggleArchive('t1')).toBe(true);
    });

    const onRefused = vi.fn();
    await act(async () => {
      expect(mail().trashThread('t1', onRefused)).toBe(false);
    });
    const pending = 'Still confirming the last move of that conversation; try again in a moment.';
    expect(onRefused).toHaveBeenCalledWith(pending);
    expect(mail().mailError).toBe(pending);
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
