// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPage } from './ThreadPage';
import type { Thread } from './thread';

const route = vi.hoisted(() => ({ threadId: 't1' }));
const mail = vi.hoisted(() => ({
  threads: [] as Thread[],
  markRead: vi.fn(),
  loadBody: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ mailbox: 'unified', _splat: route.threadId }),
  useNavigate: () => vi.fn(),
  Link: () => null,
}));
vi.mock('./use-advance', () => ({ useAdvancePast: () => vi.fn() }));
vi.mock('./ThreadReader', () => ({ ThreadReader: () => null }));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

/** A fresh object each time, as every store render hands out. */
const unread = (id: string, messageIds: readonly string[]): Thread => ({
  id,
  accounts: ['me@example.com'],
  subject: 'Lunch',
  isUnread: true,
  isReplied: false,
  isStarred: false,
  messages: messageIds.map((messageId, index) => ({
    id: messageId,
    fromName: 'Ada',
    fromAddress: 'ada@example.org',
    toAddress: 'me@example.com',
    at: index,
    body: [],
  })),
});

const root = createRoot(document.createElement('div'));
const show = async (threadId: string, ...threads: Thread[]) => {
  route.threadId = threadId;
  mail.threads = threads;
  await act(async () => root.render(<ThreadPage />));
};

afterEach(async () => {
  await act(async () => root.render(null));
  mail.markRead.mockReset();
});

describe('ThreadPage marking read', () => {
  it('marks an open thread read once, so a refused write is not retried on every render', async () => {
    await show('t1', unread('t1', ['m1']));
    // Refused: the store renders it unread again.
    await show('t1', unread('t1', ['m1']));
    await show('t1', unread('t1', ['m1']));
    expect(mail.markRead).toHaveBeenCalledTimes(1);
  });

  it('marks it again when a new message arrives into it, or when it is opened again', async () => {
    await show('t1', unread('t1', ['m1']));
    await show('t1', unread('t1', ['m1', 'm2']));
    expect(mail.markRead).toHaveBeenCalledTimes(2);

    await show('t2', unread('t1', ['m1', 'm2']), unread('t2', ['m3']));
    await show('t1', unread('t1', ['m1', 'm2']), unread('t2', ['m3']));
    expect(mail.markRead.mock.calls).toEqual([['t1'], ['t1'], ['t2'], ['t1']]);
  });

  it('marks a refused thread again when it is reopened after a read one', async () => {
    const read = { ...unread('t2', ['m2']), isUnread: false };
    await show('t1', unread('t1', ['m1']), read);
    await show('t2', unread('t1', ['m1']), read);
    await show('t1', unread('t1', ['m1']), read);
    expect(mail.markRead.mock.calls).toEqual([['t1'], ['t1']]);
  });

  it('leaves a read thread alone', async () => {
    await show('t1', { ...unread('t1', ['m1']), isUnread: false });
    expect(mail.markRead).not.toHaveBeenCalled();
  });
});
