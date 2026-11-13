// @vitest-environment jsdom

import type { Message, ThreadState } from '@yozz.app/mail/threads/thread';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadReader } from './ThreadReader';

/** A link that shows what it would navigate to: the compose intent its search sets. */
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ view: 'unified' }),
  useSearch: () => ({}),
  Link: ({
    search,
    children,
    ...rest
  }: {
    search: (previous: object) => { compose?: string };
    children: ReactNode;
  }) => (
    <a data-compose={search({}).compose} {...rest}>
      {children}
    </a>
  ),
}));

const mail = vi.hoisted(() => ({ ownedAddresses: ['me@example.com'] }));
vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    ownedAddresses: mail.ownedAddresses,
    toggleStar: vi.fn(),
    toggleArchive: vi.fn(),
    trashThread: vi.fn(),
    restoreThread: vi.fn(),
    moveThreadsWithUndo: vi.fn(),
    junkFolders: { 'me@example.com': true },
    markUnread: vi.fn(),
    loadBody: vi.fn(),
  }),
}));

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  fromName: 'Dad',
  fromAddress: 'dad@family.example',
  toAddress: 'me@example.com',
  to: [{ address: 'me@example.com' }],
  at: 0,
  body: ['Hello.'],
  locations: [{ mailbox: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: 1 }],
  ...overrides,
});

const mount = async (messages: readonly Message[]) => {
  const thread: ThreadState = {
    id: 't',
    mailboxes: ['me@example.com'],
    subject: 'Sunday',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    folders: ['inbox'],
    foldersByMailbox: { 'me@example.com': ['inbox'] },
    messages: [...messages],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ThreadReader thread={thread} onClose={vi.fn()} onTriaged={vi.fn()} />),
  );
  return {
    replyButtons: () =>
      [...document.querySelectorAll<HTMLElement>('a[data-compose]')]
        .filter(link => link.textContent === 'Reply' || link.textContent === 'Forward')
        .map(link => link.dataset.compose),
    moreMenus: () =>
      document.querySelectorAll<HTMLElement>('button[aria-label^="Reply to or forward"]'),
    toLine: () => document.querySelector('[aria-label^="To "]')?.textContent,
    unmount: () => act(async () => root.unmount()),
  };
};

beforeEach(() => {
  mail.ownedAddresses = ['me@example.com'];
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

describe('Reply and Forward in a conversation', () => {
  it('sit in full under the last message only', async () => {
    const reader = await mount([message('m-1'), message('m-2')]);
    expect(reader.replyButtons()).toEqual(['reply:m-2', 'forward:m-2']);
    await reader.unmount();
  });

  it('are one menu on each earlier message', async () => {
    const reader = await mount([message('m-1'), message('m-2'), message('m-3')]);
    expect(reader.moreMenus()).toHaveLength(2);
    expect(reader.moreMenus()[0]?.getAttribute('aria-label')).toBe(
      'Reply to or forward the message from Dad',
    );
    await reader.unmount();
  });

  it('need no menu on a single message', async () => {
    const reader = await mount([message('m-1')]);
    expect(reader.moreMenus()).toHaveLength(0);
    expect(reader.replyButtons()).toEqual(['reply:m-1', 'forward:m-1']);
    await reader.unmount();
  });

  it('open the same actions from the menu', async () => {
    const reader = await mount([message('m-1'), message('m-2')]);
    await act(async () => {
      reader.moreMenus()[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      reader.moreMenus()[0]?.click();
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.dataset.compose)).toEqual(['reply:m-1', 'forward:m-1']);
    await reader.unmount();
  });
});

describe('who a message was written to', () => {
  const twice = [
    message('m-1', { to: [{ address: 'ME@example.com' }, { address: 'ada@example.org' }] }),
  ];

  it('says "me" while there is one address to be', async () => {
    const reader = await mount(twice);
    expect(reader.toLine()).toContain('to me');
    await reader.unmount();
  });

  it('names the address it reached once there are several', async () => {
    mail.ownedAddresses = ['me@example.com', 'work@example.com'];
    const reader = await mount(twice);
    expect(reader.toLine()).toContain('ME@example.com');
    expect(reader.toLine()).not.toContain('to me,');
    await reader.unmount();
  });
});
