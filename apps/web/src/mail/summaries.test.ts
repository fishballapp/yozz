import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { type Folder, isArchived } from '../lib/thread';
import type { ThreadState } from '../state/mail';
import {
  type FolderSummaries,
  parseInternalDate,
  threadsFromAccounts,
  withDrafts,
} from './summaries';

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
  only(threadsFromSummaries(read({ inbox: [summary] }), account));

/**
 * The summaries a sync would hand the threader. UIDVALIDITY is per folder and irrelevant to
 * grouping, so one constant stands in for every folder here; the tests that care about a
 * renumbering live in `sync.test.ts`.
 */
/** One account's folders through the global pass — what most of these tests are about. */
const threadsFromSummaries = (byFolder: FolderSummaries, account: string) =>
  threadsFromAccounts({ [account]: byFolder });

const read = (byFolder: Partial<Record<Folder, readonly ImapMessageSummary[]>>): FolderSummaries =>
  Object.fromEntries(
    Object.entries(byFolder).map(([folder, summaries]) => [folder, { uidValidity: 1, summaries }]),
  );

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
    // No account prefix: the same mail delivered to two of your addresses is one message.
    expect(thread.id).toBe('mid/<msg-1@example.com>');
    expect(thread.accounts).toEqual(['user@yozz.app']);
    expect(thread.subject).toBe('Important update');
    expect(thread.isUnread).toBe(false);
    expect(thread.isStarred).toBe(true);
    expect(thread.isReplied).toBe(false);
    expect(thread.folders).toEqual(['inbox']);
    expect(thread.messages.length).toBe(1);

    const message = thread.messages[0];
    expect(message).toBeDefined();
    if (!message) return;
    expect(message.id).toBe('mid/<msg-1@example.com>');
    expect(message.locations).toEqual([
      { account: 'user@yozz.app', folder: 'inbox', uidValidity: 1, uid: 101 },
    ]);
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
      read({
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
      }),
      'user@yozz.app',
    );
    expect(threads.map(thread => thread.id)).toEqual(['mid/<msg-1@example.com>']);
    const messages = threads[0]?.messages ?? [];
    expect(messages.map(message => message.id)).toEqual([
      'mid/<msg-1@example.com>',
      'mid/<reply@yozz.app>',
    ]);
    // Sent mail went to whoever the envelope names; inbox mail arrived at this address.
    expect(messages.map(message => message.toAddress)).toEqual([
      'user@yozz.app',
      'alice@example.com',
    ]);
  });

  it('a conversation that only ever went out is keyed by its sent root', () => {
    const threads = threadsFromSummaries(read({ inbox: [], sent: [summaryOf({ uid: 3 })] }), 'u@x');
    expect(threads.map(thread => thread.id)).toEqual(['mid/<msg-1@example.com>']);
  });

  it('collects the folders a thread sits in and treats archive mail as arrived here', () => {
    const archiveOnly = threadsFromSummaries(
      read({ archive: [summaryOf({ uid: 5 })] }),
      'user@yozz.app',
    );
    expect(archiveOnly).toHaveLength(1);
    expect(archiveOnly[0]?.folders).toEqual(['archive']);
    expect(isArchived(only(archiveOnly))).toBe(true);
    expect(archiveOnly[0]?.messages[0]?.toAddress).toBe('user@yozz.app');

    const both = threadsFromSummaries(
      read({
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
      }),
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
    const [thread] = threadsFromSummaries(read({ trash: [own] }), 'user@yozz.app');
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
    const alone = threadsFromSummaries(read({ sent: [sent] }), me);
    expect(alone.map(t => t.id)).toEqual(['mid/<a@yozz>']);

    // Alice replies, I reply to that: still one thread, three messages in time order.
    const reply = theirs(10, 10, '<b@example>', '<a@yozz>');
    const mine2 = mine(2, 11, '<c@yozz>', '<b@example>');
    const live = threadsFromSummaries(read({ inbox: [reply], sent: [sent, mine2] }), me);
    expect(live).toHaveLength(1);
    expect(live[0]?.messages.map(m => m.id)).toEqual([
      'mid/<a@yozz>',
      'mid/<b@example>',
      'mid/<c@yozz>',
    ]);
    expect(isArchived(only(live))).toBe(false);

    // Archived: her reply moved to Archive, my copies stay in Sent.
    const archived = threadsFromSummaries(
      read({ sent: [sent, mine2], archive: [{ ...reply, uid: 50 }] }),
      me,
    );
    expect(archived).toHaveLength(1);
    expect(isArchived(only(archived))).toBe(true);

    // She writes again: the new inbox message brings the whole thread back.
    const again = theirs(11, 12, '<d@example>', '<c@yozz>');
    const back = threadsFromSummaries(
      read({ inbox: [again], sent: [sent, mine2], archive: [{ ...reply, uid: 50 }] }),
      me,
    );
    expect(back).toHaveLength(1);
    expect(isArchived(only(back))).toBe(false);
    expect(back[0]?.messages).toHaveLength(4);
  });
});

describe('ids that survive a move', () => {
  const me = 'user@yozz.app';
  const at = (hour: number) => `23-Aug-2026 ${String(hour).padStart(2, '0')}:00:00 +0000`;

  it('keeps a thread and its messages named the same after an archive', () => {
    const before = threadsFromSummaries(read({ inbox: [summaryOf({ uid: 7 })] }), me);
    const after = threadsFromSummaries(read({ archive: [summaryOf({ uid: 31 })] }), me);
    expect(after.map(t => t.id)).toEqual(before.map(t => t.id));
    expect(after[0]?.messages[0]?.locations).toEqual([
      { account: me, folder: 'archive', uidValidity: 1, uid: 31 },
    ]);
  });

  it('names the thread by its oldest message wherever that now sits', () => {
    const first = summaryOf({
      uid: 9,
      internalDate: at(8),
      envelope: envelope({ messageId: '<first@x>' }),
    });
    const reply = summaryOf({
      uid: 2,
      internalDate: at(9),
      envelope: envelope({
        subject: 'Re: Important update',
        messageId: '<second@x>',
        inReplyTo: '<first@x>',
      }),
    });
    const inInbox = threadsFromSummaries(read({ inbox: [reply, first] }), me);
    const firstArchived = threadsFromSummaries(
      read({ inbox: [reply], archive: [{ ...first, uid: 40 }] }),
      me,
    );
    expect(inInbox.map(t => t.id)).toEqual(['mid/<first@x>']);
    expect(firstArchived.map(t => t.id)).toEqual(['mid/<first@x>']);
  });

  it('falls back to a physical copy for a message with no Message-ID', () => {
    const none = summaryOf({ uid: 3, envelope: envelope({ messageId: null }) });
    expect(threadsFromSummaries(read({ inbox: [none] }), me).map(t => t.id)).toEqual([
      'user@yozz.app/inbox/1/3',
    ]);
  });

  it('collapses copies of one message into one, holding every place it sits', () => {
    const copies = threadsFromSummaries(
      read({ inbox: [summaryOf({ uid: 5 })], archive: [summaryOf({ uid: 6 })] }),
      me,
    );
    const messages = copies.flatMap(thread => thread.messages);
    expect(messages.map(m => m.id)).toEqual(['mid/<msg-1@example.com>']);
    // One row on screen, two copies underneath — which is what every write has to address.
    expect(messages[0]?.locations).toEqual([
      { account: me, folder: 'inbox', uidValidity: 1, uid: 5 },
      { account: me, folder: 'archive', uidValidity: 1, uid: 6 },
    ]);
  });

  it('keeps two different messages apart when they share a Message-ID', () => {
    // A collision is rare by accident and cheap for a sender to arrange. The fingerprint — From,
    // envelope Date and base subject alongside the id — is what stops it merging strangers, and
    // neither may then claim the `mid/` name.
    const impostor = summaryOf({
      uid: 9,
      envelope: envelope({
        subject: 'Something else',
        from: [{ name: 'Not Alice', mailbox: 'mallory', host: 'example.com' }],
      }),
    });
    const threads = threadsFromSummaries(read({ inbox: [summaryOf({ uid: 5 }), impostor] }), me);
    expect(threads.flatMap(t => t.messages.map(m => m.id)).toSorted()).toEqual([
      'user@yozz.app/inbox/1/5',
      'user@yozz.app/inbox/1/9',
    ]);
  });
});

describe('threads that span accounts', () => {
  const work = 'work@yozz.app';
  const home = 'home@yozz.app';

  it('is one thread when the same mail reached two of your addresses', () => {
    // One RFC message, delivered twice. Two rows would be wrong: it is one conversation.
    const delivered = summaryOf({ uid: 1 });
    const threads = threadsFromAccounts({
      [work]: read({ inbox: [delivered] }),
      [home]: read({ inbox: [{ ...delivered, uid: 42 }] }),
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.accounts).toEqual([home, work]);
    expect(threads[0]?.messages).toHaveLength(1);
    // Same folder and same instant, so the tie breaks on the physical id: deterministic, and
    // independent of which account happened to sync first.
    expect(threads[0]?.messages[0]?.locations).toEqual([
      { account: home, folder: 'inbox', uidValidity: 1, uid: 42 },
      { account: work, folder: 'inbox', uidValidity: 1, uid: 1 },
    ]);
  });

  it('is unread when ANY account holds an unread copy of the same message', () => {
    // The copy that happens to lead the merge is not the one that decides: a message read on one
    // account is still unread on the other, and showing it as read would hide it.
    const delivered = summaryOf({ uid: 1, flags: [] });
    const threads = threadsFromAccounts({
      [work]: read({ inbox: [delivered] }),
      [home]: read({ inbox: [{ ...delivered, uid: 2, flags: ['\\Seen'] }] }),
    });
    expect(threads[0]?.messages).toHaveLength(1);
    expect(threads[0]?.isUnread).toBe(true);
  });

  it('is starred when any copy is, whichever account holds it', () => {
    const delivered = summaryOf({ uid: 1, flags: ['\\Seen', '\\Flagged'] });
    const threads = threadsFromAccounts({
      [work]: read({ inbox: [delivered] }),
      [home]: read({ inbox: [{ ...delivered, uid: 2, flags: ['\\Seen'] }] }),
    });
    expect(threads[0]?.isStarred).toBe(true);
  });

  it('leaves the Drafts folder out of threading entirely', () => {
    // Synced for the mirror, but not mail: threading one in would count it as unread, expose it
    // through its thread's other messages, and make it a target for flag writes.
    const threads = threadsFromAccounts({
      [work]: read({ inbox: [summaryOf({ uid: 1 })], drafts: [summaryOf({ uid: 2 })] }),
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages).toHaveLength(1);
    expect(threads[0]?.folders).toEqual(['inbox']);
  });

  it('joins a reply that only one account holds, and says which folders each account has it in', () => {
    const root = summaryOf({ uid: 1 });
    const reply = summaryOf({
      uid: 2,
      internalDate: '23-Aug-2026 10:00:00 +0000',
      envelope: envelope({
        date: 'Sun, 23 Aug 2026 10:00:00 +0000',
        messageId: '<reply@x>',
        subject: 'Re: Important update',
        inReplyTo: '<msg-1@example.com>',
      }),
    });
    const threads = threadsFromAccounts({
      [work]: read({ archive: [root] }),
      [home]: read({ inbox: [reply] }),
    });
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    expect(thread?.messages.map(m => m.id)).toEqual(['mid/<msg-1@example.com>', 'mid/<reply@x>']);
    // The rollups a view reads: globally it is in both folders, but each account holds it in
    // exactly one — which is why an address's view cannot be answered from the global one.
    expect(thread?.folders).toEqual(['inbox', 'archive']);
    expect(thread?.foldersByAccount).toEqual({ [work]: ['archive'], [home]: ['inbox'] });
  });

  it('threads mail the vault holds for a send-only address, body and all', () => {
    // Nothing on any server holds this message, so if it did not join the grouping pass it would
    // not exist anywhere in the app.
    const threads = threadsFromAccounts({ [work]: read({ inbox: [summaryOf({ uid: 1 })] }) }, [
      {
        messageId: '<sent@alias>',
        at: 1_700_000_000_000,
        date: 'Sun, 23 Aug 2026 11:00:00 +0000',
        from: 'alias@example.com',
        to: 'alice@example.com',
        cc: '',
        subject: 'Re: Important update',
        body: 'Sent from an address with no mailbox.',
        inReplyTo: '<msg-1@example.com>',
      },
    ]);
    const thread = only(threads);
    expect(thread.messages.map(m => m.id)).toEqual(['mid/<msg-1@example.com>', 'mid/<sent@alias>']);
    // Its text is already here, so the reader never asks a server it does not have for it.
    expect(thread.messages[1]?.body).toEqual(['Sent from an address with no mailbox.']);
    expect(thread.messages[1]?.bodyStatus).toBeUndefined();
  });

  it('collapses the vault copy into the real one once a mailbox holds the same message', () => {
    // Adoption: the address gained a mailbox, or the provider kept its own copy. One row, and the
    // server's copy leads it — the one that can be moved, flagged and fetched.
    const real = summaryOf({
      uid: 7,
      envelope: envelope({
        messageId: '<sent@alias>',
        subject: 'Re: Important update',
        date: 'Sun, 23 Aug 2026 11:00:00 +0000',
        from: [{ name: null, mailbox: 'alias', host: 'example.com' }],
      }),
    });
    const threads = threadsFromAccounts({ [work]: read({ sent: [real] }) }, [
      {
        messageId: '<sent@alias>',
        at: 1_700_000_000_000,
        date: 'Sun, 23 Aug 2026 11:00:00 +0000',
        from: 'alias@example.com',
        to: 'alice@example.com',
        cc: '',
        subject: 'Re: Important update',
        body: 'Sent from an address with no mailbox.',
      },
    ]);
    const thread = only(threads);
    expect(thread.messages).toHaveLength(1);
    // The server's copy leads, so a body fetch and a move act on the one that can be acted on.
    expect(thread.messages[0]?.locations?.[0]?.account).toBe(work);
    expect(thread.messages[0]?.locations?.map(l => l.account)).toContain('alias@example.com');
  });

  it('shows a draft in the conversation it replies to, and alone when it replies to nothing', () => {
    const threads = threadsFromAccounts({ [work]: read({ inbox: [summaryOf({ uid: 1 })] }) });
    const draft = (over: Record<string, unknown>) => ({
      draftKey: 'k1',
      draftId: 'k1@2',
      record: {
        from: work,
        to: 'alice@example.com',
        cc: '',
        bcc: '',
        subject: 'Re: Important update',
        body: 'Half a thought',
        contentVersion: 2,
        updatedAt: 2_000,
        ...over,
      },
    });

    const inThread = withDrafts(threads, [draft({ inReplyTo: '<msg-1@example.com>' })]);
    expect(inThread).toHaveLength(1);
    expect(only(inThread).messages.map(m => m.id)).toEqual(['mid/<msg-1@example.com>', 'draft/k1']);
    // Which is what lists the whole conversation under Drafts.
    expect(only(inThread).folders).toContain('drafts');

    const alone = withDrafts(threads, [draft({})]);
    expect(alone).toHaveLength(2);
    expect(alone.find(thread => thread.id === 'draft/k1')?.messages[0]?.body).toEqual([
      'Half a thought',
    ]);
  });
});
