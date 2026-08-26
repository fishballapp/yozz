import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { isArchived, parseThreadId } from '../lib/thread';
import type { ThreadState } from '../state/mail';
import { parseInternalDate, threadsFromSummaries } from './summaries';

const envelope = (over: Partial<ImapMessageSummary['envelope'] & {}> = {}) => ({
  date: 'Sun, 23 Aug 2026 09:00:00 +0000',
  subject: 'Important update',
  subjectRaw: 'Important update',
  from: [{ name: 'Alice Smith', mailbox: 'alice', host: 'example.com' }],
  sender: [],
  replyTo: [],
  to: [{ name: null, mailbox: 'user', host: 'yozz.app' }],
  cc: [],
  bcc: [],
  inReplyTo: null,
  messageId: '<msg-1@example.com>',
  ...over,
});

const summaryOf = (over: Partial<ImapMessageSummary> = {}): ImapMessageSummary => ({
  seq: 1,
  uid: 101,
  flags: ['\\Seen', '\\Flagged'],
  internalDate: '23-Aug-2026 09:00:00 +0000',
  size: 1024,
  envelope: envelope(),
  references: [],
  gmailThreadId: null,
  ...over,
});

/** The single thread a case built — indexing an array is what makes it optional, not the code. */
const only = (threads: readonly ThreadState[]) => {
  const thread = threads[0];
  if (thread === undefined) throw new Error('expected one thread');
  return thread;
};

/** One summary makes one thread; the multi-message threading is `lib/threading.test.ts`. */
const threadFromSummary = (summary: ImapMessageSummary, account: string) =>
  only(threadsFromSummaries({ inbox: [summary] }, account));

describe('parseInternalDate', () => {
  it('parses internalDate with UTC timezone (+0000)', () => {
    const timestamp = parseInternalDate('23-Aug-2026 09:00:00 +0000');
    expect(timestamp).toBe(Date.UTC(2026, 7, 23, 9, 0, 0));
  });

  it('parses internalDate with positive offset timezone (+0200)', () => {
    const timestamp = parseInternalDate('23-Aug-2026 09:00:00 +0200');
    expect(timestamp).toBe(Date.UTC(2026, 7, 23, 7, 0, 0));
  });

  it('parses internalDate with negative offset timezone (-0400)', () => {
    const timestamp = parseInternalDate('23-Aug-2026 09:00:00 -0400');
    expect(timestamp).toBe(Date.UTC(2026, 7, 23, 13, 0, 0));
  });

  it('parses internalDate with leading space in day', () => {
    const timestamp = parseInternalDate(' 3-Aug-2026 09:00:00 +0000');
    expect(timestamp).toBe(Date.UTC(2026, 7, 3, 9, 0, 0));
  });

  it('returns null on invalid string or null', () => {
    expect(parseInternalDate(null)).toBeNull();
    expect(parseInternalDate('invalid-date')).toBeNull();
  });
});

describe('threadFromSummary', () => {
  it('maps a summary with flags correctly', () => {
    const thread = threadFromSummary(summaryOf(), 'user@yozz.app');
    expect(thread.id).toBe('user@yozz.app/inbox/101');
    expect(thread.accountId).toBe('user@yozz.app');
    expect(thread.subject).toBe('Important update');
    expect(thread.isUnread).toBe(false);
    expect(thread.isStarred).toBe(true);
    expect(thread.isReplied).toBe(false);
    expect(thread.folders).toEqual(['inbox']);
    expect(thread.messages.length).toBe(1);

    const message = thread.messages[0];
    expect(message).toBeDefined();
    if (!message) return;
    expect(message.id).toBe('user@yozz.app/inbox/101');
    expect(message.fromName).toBe('Alice Smith');
    expect(message.fromAddress).toBe('alice@example.com');
    expect(message.bodyStatus).toBe('pending');
    expect(message.rawSize).toBe(1024);
    expect(message.messageId).toBe('<msg-1@example.com>');
    expect(message.toAddress).toBe('user@yozz.app');
    expect(message.at).toBe(Date.UTC(2026, 7, 23, 9, 0, 0));
    expect(message.body).toEqual([]);
  });

  it('collects To and Cc as the recipients Reply all offers', () => {
    const thread = threadFromSummary(
      summaryOf({
        envelope: envelope({
          to: [
            { name: null, mailbox: 'User', host: 'YOZZ.app' },
            { name: 'Sam', mailbox: 'sam', host: 'example.com' },
          ],
          cc: [
            { name: null, mailbox: 'kim', host: 'example.com' },
            // The same address twice, differently cased, is one recipient.
            { name: null, mailbox: 'user', host: 'yozz.app' },
            // No mailbox or host is not an address; a group syntax marker parses this way.
            { name: 'The team', mailbox: null, host: null },
          ],
        }),
      }),
      'user@yozz.app',
    );
    expect(thread.messages[0]?.recipients).toEqual([
      'user@yozz.app',
      'sam@example.com',
      'kim@example.com',
    ]);
  });

  it('maps a summary without a subject to (no subject)', () => {
    const thread = threadFromSummary(
      summaryOf({
        uid: 102,
        flags: [],
        envelope: envelope({ subject: null, subjectRaw: null, messageId: null }),
      }),
      'user@yozz.app',
    );
    expect(thread.subject).toBe('(no subject)');
    expect(thread.isUnread).toBe(true);
    expect(thread.isStarred).toBe(false);
  });

  it('maps a summary with from whose name is null to mailbox@host', () => {
    const thread = threadFromSummary(
      summaryOf({
        uid: 103,
        flags: ['\\Answered'],
        envelope: envelope({
          from: [{ name: null, mailbox: 'carol', host: 'example.org' }],
          messageId: null,
        }),
      }),
      'user@yozz.app',
    );
    expect(thread.messages[0]?.fromName).toBe('carol@example.org');
    expect(thread.messages[0]?.fromAddress).toBe('carol@example.org');
    expect(thread.isReplied).toBe(true);
  });
});

describe('threadsFromSummaries across folders', () => {
  it('puts a sent reply in the inbox thread it answers, keyed by the inbox root', () => {
    const threads = threadsFromSummaries(
      {
        inbox: [summaryOf({ uid: 7 })],
        sent: [
          summaryOf({
            // The same uid in another folder is another message.
            uid: 7,
            internalDate: '23-Aug-2026 10:00:00 +0000',
            envelope: envelope({
              subject: 'Re: Important update',
              messageId: '<reply@yozz.app>',
              inReplyTo: '<msg-1@example.com>',
              from: [{ name: 'Me', mailbox: 'user', host: 'yozz.app' }],
              to: [{ name: null, mailbox: 'alice', host: 'example.com' }],
            }),
          }),
        ],
      },
      'user@yozz.app',
    );
    expect(threads.map(thread => thread.id)).toEqual(['user@yozz.app/inbox/7']);
    const messages = threads[0]?.messages ?? [];
    expect(messages.map(message => message.id)).toEqual([
      'user@yozz.app/inbox/7',
      'user@yozz.app/sent/7',
    ]);
    // Sent mail went to whoever the envelope names; inbox mail arrived at this address.
    expect(messages.map(message => message.toAddress)).toEqual([
      'user@yozz.app',
      'alice@example.com',
    ]);
  });

  it('a conversation that only ever went out is keyed by its sent root', () => {
    const threads = threadsFromSummaries({ inbox: [], sent: [summaryOf({ uid: 3 })] }, 'u@x');
    expect(threads.map(thread => thread.id)).toEqual(['u@x/sent/3']);
  });

  it('collects the folders a thread sits in and treats archive mail as arrived here', () => {
    const archiveOnly = threadsFromSummaries({ archive: [summaryOf({ uid: 5 })] }, 'user@yozz.app');
    expect(archiveOnly).toHaveLength(1);
    expect(archiveOnly[0]?.folders).toEqual(['archive']);
    expect(isArchived(only(archiveOnly))).toBe(true);
    expect(archiveOnly[0]?.messages[0]?.toAddress).toBe('user@yozz.app');

    const both = threadsFromSummaries(
      {
        inbox: [
          summaryOf({ uid: 5 }),
          summaryOf({
            uid: 6,
            internalDate: '23-Aug-2026 11:00:00 +0000',
            envelope: envelope({
              messageId: '<latest@example.com>',
              inReplyTo: '<msg-1@example.com>',
            }),
          }),
        ],
        archive: [
          summaryOf({
            uid: 9,
            internalDate: '23-Aug-2026 10:00:00 +0000',
            envelope: envelope({
              messageId: '<later@example.com>',
              inReplyTo: '<msg-1@example.com>',
            }),
          }),
        ],
      },
      'user@yozz.app',
    );
    expect(both).toHaveLength(1);
    // One entry per folder however many messages sit there, and in FOLDERS order.
    expect(only(both).messages).toHaveLength(3);
    expect(only(both).folders).toEqual(['inbox', 'archive']);
    expect(isArchived(only(both))).toBe(false);
  });
});

describe('an outbound copy that a delete moved', () => {
  it('still says who it went to, so it is never mistaken for mail that arrived', () => {
    const own = summaryOf({
      uid: 7,
      envelope: envelope({
        from: [{ name: null, mailbox: 'user', host: 'YOZZ.app' }],
        to: [{ name: null, mailbox: 'alice', host: 'example.com' }],
      }),
    });
    const [thread] = threadsFromSummaries({ trash: [own] }, 'user@yozz.app');
    expect(thread?.messages[0]?.toAddress).toBe('alice@example.com');
  });
});

describe('a conversation through its life', () => {
  const at = (hour: number) => `23-Aug-2026 ${String(hour).padStart(2, '0')}:00:00 +0000`;
  const mine = (uid: number, hour: number, messageId: string, inReplyTo: string | null) =>
    summaryOf({
      uid,
      internalDate: at(hour),
      envelope: envelope({
        subject: hour === 9 ? 'Quote' : 'Re: Quote',
        messageId,
        inReplyTo,
        from: [{ name: null, mailbox: 'user', host: 'yozz.app' }],
        to: [{ name: null, mailbox: 'alice', host: 'example.com' }],
      }),
    });
  const theirs = (uid: number, hour: number, messageId: string, inReplyTo: string) =>
    summaryOf({
      uid,
      internalDate: at(hour),
      envelope: envelope({ subject: 'Re: Quote', messageId, inReplyTo }),
    });
  const me = 'user@yozz.app';

  it('is one thread whose folders follow where its messages sit', () => {
    // Sent, no reply yet: one thread, nothing inbound, not archived (the view keeps it out of the inbox).
    const sent = mine(1, 9, '<a@yozz>', null);
    const alone = threadsFromSummaries({ sent: [sent] }, me);
    expect(alone.map(t => t.id)).toEqual(['user@yozz.app/sent/1']);

    // Alice replies, I reply to that: still one thread, three messages in time order.
    const reply = theirs(10, 10, '<b@example>', '<a@yozz>');
    const mine2 = mine(2, 11, '<c@yozz>', '<b@example>');
    const live = threadsFromSummaries({ inbox: [reply], sent: [sent, mine2] }, me);
    expect(live).toHaveLength(1);
    expect(live[0]?.messages.map(m => m.id)).toEqual([
      'user@yozz.app/sent/1',
      'user@yozz.app/inbox/10',
      'user@yozz.app/sent/2',
    ]);
    expect(isArchived(only(live))).toBe(false);

    // Archived: her reply moved to Archive, my copies stay in Sent.
    const archived = threadsFromSummaries(
      { sent: [sent, mine2], archive: [{ ...reply, uid: 50 }] },
      me,
    );
    expect(archived).toHaveLength(1);
    expect(isArchived(only(archived))).toBe(true);

    // She writes again: the new inbox message brings the whole thread back.
    const again = theirs(11, 12, '<d@example>', '<c@yozz>');
    const back = threadsFromSummaries(
      { inbox: [again], sent: [sent, mine2], archive: [{ ...reply, uid: 50 }] },
      me,
    );
    expect(back).toHaveLength(1);
    expect(isArchived(only(back))).toBe(false);
    expect(back[0]?.messages).toHaveLength(4);
  });
});

describe('parseThreadId', () => {
  it('splits off the folder and uid, and refuses anything else', () => {
    expect(parseThreadId('a/b@c.test/inbox/12')).toEqual({
      accountAddress: 'a/b@c.test',
      folder: 'inbox',
      uid: 12,
    });
    expect(parseThreadId('a@c.test/sent/12')?.folder).toBe('sent');
    expect(parseThreadId('a@c.test/drafts/12')).toBeNull();
    expect(parseThreadId('a@c.test/inbox/x')).toBeNull();
    expect(parseThreadId('a@c.test/12')).toBeNull();
    expect(parseThreadId('noslash')).toBeNull();
  });
});
