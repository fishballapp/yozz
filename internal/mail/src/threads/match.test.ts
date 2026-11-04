import { describe, expect, it } from 'vitest';
import { messageMatches, threadMatches } from './match.ts';
import { parseQuery } from './query.ts';
import type { Message, ThreadState } from './thread.ts';
import { visibleThreads } from './views.ts';

const NOV_3 = Date.UTC(2026, 10, 3, 12);

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm',
  fromName: 'Stripe Billing',
  fromAddress: 'billing@stripe.com',
  toAddress: 'me@x.co',
  to: [{ name: 'Jason Yu', address: 'jason@x.co' }],
  cc: [{ name: 'Ann Lee', address: 'ann@y.co' }],
  replyTo: [{ name: 'Help Desk', address: 'help@stripe.com' }],
  bcc: [{ address: 'hidden@z.co' }],
  attachmentNames: ['Invoice-0003.pdf'],
  attachments: [{ name: 'parsed-only.zip', size: 1, kind: 'archive' }],
  at: NOV_3,
  body: ['Thanks for your', 'payment.'],
  ...over,
});

const matches = (text: string, over: Partial<Message> = {}) =>
  messageMatches(parseQuery(text), message(over), 'Your receipt');

describe('messageMatches', () => {
  it.each([
    'receipt',
    'STRIPE BILLING',
    'billing@stripe.com',
    'jason yu',
    'jason@x.co',
    'ann lee',
    'ann@y.co',
    'help desk',
    'help@stripe.com',
    'hidden@z.co',
    'invoice-0003',
    'parsed-only',
    'payment',
  ])('finds %j anywhere in the message', text => {
    expect(matches(text)).toBe(true);
    expect(matches('nothing-like-this')).toBe(false);
  });

  it('confines an operator to its field', () => {
    expect(matches('from:stripe')).toBe(true);
    expect(matches('from:ann')).toBe(false);
    expect(matches('to:ann')).toBe(true);
    expect(matches('to:jason')).toBe(true);
    expect(matches('to:stripe')).toBe(false);
    expect(matches('to:help@stripe.com')).toBe(false);
    expect(matches('to:hidden@z.co')).toBe(false);
    expect(matches('subject:receipt')).toBe(true);
    expect(matches('subject:payment')).toBe(false);
  });

  it('does not read the address holding the copy as who it was sent to', () => {
    expect(matches('to:me@x.co')).toBe(false);
  });

  it('reads a draft’s To line as typed, which is all it has', () => {
    expect(matches('to:bo@x.co', { to: undefined, cc: undefined, toAddress: 'bo@x.co' })).toBe(
      true,
    );
  });

  it('holds after: on or after the day, before: strictly before it', () => {
    expect(matches('after:2026/11/03')).toBe(true);
    expect(matches('after:2026/11/04')).toBe(false);
    expect(matches('before:2026/11/04')).toBe(true);
    expect(matches('before:2026/11/03')).toBe(false);
  });
});

describe('threadMatches', () => {
  const thread = (messages: readonly Partial<Message>[], over: Partial<ThreadState> = {}) =>
    ({
      id: 't',
      accounts: [],
      subject: 'Your receipt',
      messages: messages.map(message),
      isUnread: false,
      isReplied: false,
      isStarred: false,
      folders: ['inbox'],
      foldersByAccount: {},
      ...over,
    }) satisfies ThreadState;
  const holds = (text: string, target: ThreadState) => threadMatches(parseQuery(text))(target);

  it('wants every term in one message, not across the conversation', () => {
    const split = thread([{ body: ['alpha'] }, { body: ['beta'] }]);
    expect(holds('alpha', split)).toBe(true);
    expect(holds('beta', split)).toBe(true);
    expect(holds('alpha beta', split)).toBe(false);
    expect(holds('alpha beta', thread([{ body: ['alpha beta'] }]))).toBe(true);
  });

  it('asks the flags of the message that holds the terms', () => {
    const unread = thread([{ body: ['alpha'], isUnread: true }], { isUnread: true });
    expect(holds('is:unread', unread)).toBe(true);
    expect(holds('is:unread alpha', unread)).toBe(true);
    expect(holds('is:starred', unread)).toBe(false);
    expect(holds('is:unread is:starred', unread)).toBe(false);

    const mixed = thread([{ body: ['alpha'] }, { body: ['beta'], isUnread: true }], {
      isUnread: true,
    });
    expect(holds('is:unread', mixed)).toBe(true);
    expect(holds('is:unread beta', mixed)).toBe(true);
    expect(holds('is:unread alpha', mixed)).toBe(false);
  });

  it('follows a write still pending, which shows on the conversation alone', () => {
    const justRead = thread([{ body: ['alpha'], isUnread: true }], { isUnread: false });
    expect(holds('is:unread', justRead)).toBe(false);

    const justStarred = thread([{ body: ['alpha'] }], { isStarred: true });
    expect(holds('is:starred', justStarred)).toBe(true);
    expect(holds('is:starred alpha', justStarred)).toBe(true);
    expect(holds('is:starred beta', justStarred)).toBe(false);
  });

  describe('visibleThreads', () => {
    const inbox = thread([{ body: ['alpha'] }], { id: 'in-inbox' });
    const archived = thread([{ body: ['alpha'] }], { id: 'archived', folders: ['archive'] });
    const idsOf = (query: string | undefined, mailbox = 'unified') =>
      visibleThreads([inbox, archived], mailbox, query).map(({ id }) => id);

    it('applies the criteria inside the view, whatever in: and mailbox: say', () => {
      expect(idsOf(undefined)).toEqual(['in-inbox']);
      expect(idsOf('  ')).toEqual(['in-inbox']);
      expect(idsOf('alpha')).toEqual(['in-inbox']);
      expect(idsOf('alpha', 'archive')).toEqual(['archived']);
      expect(idsOf('nothing')).toEqual([]);
      expect(idsOf('in:archive')).toEqual(['in-inbox']);
      expect(idsOf('alpha in:archive mailbox:a@b.co')).toEqual(['in-inbox']);
    });
  });
});
