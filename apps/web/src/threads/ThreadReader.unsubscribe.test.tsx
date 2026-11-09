// @vitest-environment jsdom

import type { Folder, Message, ThreadState } from '@yozz.app/mail/threads/thread';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadReader } from './ThreadReader';

/** A link that shows what it would navigate to: the compose intent its search sets. */
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ view: 'unified' }),
  Link: ({
    search,
    children,
    className,
    ...rest
  }: {
    search: (previous: object) => { compose?: string };
    children: ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a data-compose={search({}).compose} className={className} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    ownedAddresses: ['me@example.com'],
    toggleStar: vi.fn(),
    toggleArchive: vi.fn(),
    trashThread: vi.fn(),
    restoreThread: vi.fn(),
    moveThreads: vi.fn(),
    junkFolders: { 'me@example.com': true },
    markUnread: vi.fn(),
    loadBody: vi.fn(),
  }),
}));

const newsletter = (overrides: Partial<Message>): Message => ({
  id: 'm-1',
  fromName: 'Picks',
  fromAddress: 'news@picks.example',
  toAddress: 'me@example.com',
  to: [{ address: 'me@example.com' }],
  at: 0,
  body: ['This week.'],
  locations: [{ mailbox: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: 1 }],
  ...overrides,
});

const mount = async (message: Message, folders: readonly Folder[] = ['inbox']) => {
  const thread: ThreadState = {
    id: 't',
    mailboxes: ['me@example.com'],
    subject: 'Weekly picks',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    folders,
    foldersByMailbox: { 'me@example.com': folders },
    messages: [message],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ThreadReader thread={thread} onClose={vi.fn()} onTriaged={vi.fn()} />),
  );
  return {
    action: () => document.querySelector<HTMLAnchorElement>('[aria-label="Unsubscribe"]'),
    unmount: () => act(async () => root.unmount()),
  };
};

const BOTH = {
  https: 'https://picks.example/u/1',
  mailto: 'mailto:leave@picks.example?subject=Unsubscribe',
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the reader’s Unsubscribe', () => {
  it('opens the sender’s https: page in a new tab that learns nothing of this one', async () => {
    const reader = await mount(newsletter({ unsubscribe: BOTH }));
    const link = reader.action();
    expect(link?.textContent).toBe('Unsubscribe');
    expect(link?.getAttribute('href')).toBe('https://picks.example/u/1');
    expect(link?.target).toBe('_blank');
    expect(link?.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
    expect(link?.dataset.compose).toBeUndefined();
    await reader.unmount();
  });

  it('writes a draft from the mailto: when there is no https: page', async () => {
    const reader = await mount(newsletter({ id: 'm-7', unsubscribe: { mailto: BOTH.mailto } }));
    const link = reader.action();
    expect(link?.textContent).toBe('Unsubscribe');
    // The composer's intent, not a link out: nothing is sent until the person presses Send.
    expect(link?.dataset.compose).toBe('unsubscribe:m-7');
    expect(link?.hasAttribute('href')).toBe(false);
    await reader.unmount();
  });

  it('is not offered for a message that offers nothing', async () => {
    for (const unsubscribe of [null, undefined, {}]) {
      const reader = await mount(newsletter({ unsubscribe }));
      expect(reader.action()).toBeNull();
      await reader.unmount();
    }
  });

  it('is not offered in Junk, where unsubscribing confirms a live address', async () => {
    const reader = await mount(newsletter({ unsubscribe: BOTH }), ['junk']);
    expect(reader.action()).toBeNull();
    await reader.unmount();
  });
});
