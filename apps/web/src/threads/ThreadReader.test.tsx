// @vitest-environment jsdom

import type { Message, ThreadState } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadReader } from './ThreadReader';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ mailbox: 'unified' }),
  Link: () => null,
}));
vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    ownedAddresses: ['me@example.com'],
    toggleStar: vi.fn(),
    toggleArchive: vi.fn(),
    trashThread: vi.fn(),
    restoreThread: vi.fn(),
    markUnread: vi.fn(),
    loadBody: vi.fn(),
  }),
}));

const received = (overrides: Partial<Message>): Message => ({
  id: 'm',
  fromName: 'Stripe',
  fromAddress: 'billing@stripe.com',
  toAddress: 'me@example.com',
  to: [{ address: 'me@example.com' }],
  at: 0,
  body: ['Your invoice.'],
  locations: [{ account: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: 1 }],
  ...overrides,
});

const mount = async (message: Message) => {
  const thread: ThreadState = {
    id: 't',
    accounts: ['me@example.com'],
    subject: 'Invoice',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    folders: ['inbox'],
    foldersByAccount: { 'me@example.com': ['inbox'] },
    messages: [message],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ThreadReader thread={thread} onClose={vi.fn()} onTriaged={vi.fn()} />),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label^="To "]')?.click());
  return {
    details: () => document.querySelector('[aria-label="Message details"]')?.textContent ?? '',
    unmount: () => act(async () => root.unmount()),
  };
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('the message details panel: signed by', () => {
  it('names the domain whose signature vouches for the sender', async () => {
    const reader = await mount(
      received({ senderCheck: { status: 'verified', signedBy: 'stripe.com' } }),
    );
    expect(reader.details()).toContain('signed bystripe.com');
    await reader.unmount();
  });

  it("says it couldn't be verified, and does not call the sender forged", async () => {
    const reader = await mount(received({ senderCheck: { status: 'unverified' } }));
    expect(reader.details()).toContain("signed bycouldn't be verified");
    await reader.unmount();
  });

  it('says nothing before the body, and so the check, has arrived', async () => {
    const reader = await mount(received({ bodyStatus: 'loading' }));
    expect(reader.details()).not.toContain('signed by');
    await reader.unmount();
  });

  it('has no row for your own sent copy', async () => {
    const reader = await mount(
      received({
        fromName: 'Me',
        fromAddress: 'me@example.com',
        to: [{ address: 'ada@example.org' }],
        locations: [{ account: 'me@example.com', folder: 'sent', uidValidity: 1, uid: 2 }],
        senderCheck: { status: 'unverified' },
      }),
    );
    expect(reader.details()).toContain('from');
    expect(reader.details()).not.toContain('signed by');
    await reader.unmount();
  });
});
