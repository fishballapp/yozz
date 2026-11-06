// @vitest-environment jsdom

import type { Message, ThreadState } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadReader } from './ThreadReader';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ view: 'unified' }),
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
  locations: [{ mailbox: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: 1 }],
  ...overrides,
});

/** jsdom has no matchMedia; the details open as a popover from `lg` and inline below it. */
const stubViewport = (isWide: boolean) =>
  vi.stubGlobal('matchMedia', () => ({
    matches: isWide,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const mount = async (message: Message, { shouldOpen = true } = {}) => {
  const thread: ThreadState = {
    id: 't',
    mailboxes: ['me@example.com'],
    subject: 'Invoice',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    folders: ['inbox'],
    foldersByMailbox: { 'me@example.com': ['inbox'] },
    messages: [message],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ThreadReader thread={thread} onClose={vi.fn()} onTriaged={vi.fn()} />),
  );
  const trigger = () => document.querySelector<HTMLElement>('[aria-label^="To "]');
  if (shouldOpen) await act(async () => trigger()?.click());
  return {
    trigger,
    toggle: () => act(async () => trigger()?.click()),
    details: () => document.querySelector('[aria-label="Message details"]')?.textContent ?? '',
    unmount: () => act(async () => root.unmount()),
  };
};

beforeEach(() => stubViewport(true));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
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

  it('says a check still under way is under way, not that it failed', async () => {
    const reader = await mount(received({ senderCheck: { status: 'checking' } }));
    expect(reader.details()).toContain('signed bychecking…');
    expect(reader.details()).not.toContain("couldn't be verified");
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
        locations: [{ mailbox: 'me@example.com', folder: 'sent', uidValidity: 1, uid: 2 }],
        senderCheck: { status: 'unverified' },
      }),
    );
    expect(reader.details()).toContain('from');
    expect(reader.details()).not.toContain('signed by');
    await reader.unmount();
  });
});

describe('the message details below lg: an inline disclosure', () => {
  beforeEach(() => stubViewport(false));

  it('starts closed, opens in the message on a tap, and shows the rows', async () => {
    const reader = await mount(received({ cc: [{ name: 'Ada', address: 'ada@example.org' }] }), {
      shouldOpen: false,
    });
    expect(reader.trigger()?.getAttribute('aria-expanded')).toBe('false');
    await reader.toggle();
    expect(reader.trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(reader.details()).toContain('ada@example.org');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await reader.unmount();
  });

  it('collapses on a second tap, and the trigger names the region it controls', async () => {
    const reader = await mount(received({}));
    const region = document.querySelector<HTMLElement>('[aria-label="Message details"]');
    expect(reader.trigger()?.getAttribute('aria-controls')).toBe(region?.id);
    expect(region?.hidden).toBe(false);
    await reader.toggle();
    expect(reader.trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(region?.hidden).toBe(true);
    await reader.unmount();
  });
});
