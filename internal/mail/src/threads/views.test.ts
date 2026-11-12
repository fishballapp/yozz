import { describe, expect, it } from 'vitest';
import { windowsOf } from './paging.ts';
import type { MailboxSyncState } from './sync.ts';
import type { Folder, Message, ThreadState } from './thread.ts';
import {
  listingOf,
  neighbourOf,
  olderAvailable,
  queryOfView,
  syncProgressIn,
  threadsIn,
  viewOfQuery,
} from './views.ts';

const message = (id: string): Message => ({
  id,
  fromName: 'x',
  fromAddress: 'x@x',
  toAddress: 'me@x',
  at: 1,
  body: [],
});

const thread = (id: string, folders: readonly Folder[], isStarred = false): ThreadState => ({
  id,
  mailboxes: ['me@x'],
  foldersByMailbox: { 'me@x': folders },
  subject: id,
  messages: [message(`${id}/1`)],
  isUnread: false,
  isReplied: false,
  isStarred,
  folders,
});

describe('threadsIn', () => {
  const inbox = thread('inbox', ['inbox', 'sent'], true);
  const sentOnly = thread('sent-only', ['sent']);
  const archived = thread('archived', ['sent', 'archive'], true);
  const trashed = thread('trashed', ['trash'], true);
  // One message deleted, the rest of the conversation still live: in both places, as in Gmail.
  const halfTrashed = thread('half-trashed', ['inbox', 'trash']);
  const junk = thread('junk', ['junk'], true);
  const all = [inbox, sentOnly, archived, trashed, halfTrashed, junk];

  const idsIn = (view: string) => threadsIn(all, view).map(t => t.id);

  it('keeps a thread of only your own sent mail out of the inbox, and Trash out of every live view', () => {
    expect(idsIn('unified')).toEqual(['inbox', 'half-trashed']);
    expect(idsIn('starred')).toEqual(['inbox', 'archived']);
    expect(idsIn('sent')).toEqual(['inbox', 'sent-only', 'archived']);
  });

  it('shows archived mail only in Archive, and everything with a trashed message in Trash', () => {
    expect(idsIn('archive')).toEqual(['archived']);
    expect(idsIn('trash')).toEqual(['trashed', 'half-trashed']);
  });

  it('keeps a conversation half moved to Junk out of Junk, and in Starred and Sent', () => {
    // Move to Junk leaves your own Sent copy where it was until the sync splits the two.
    const halfJunk = thread('half-junk', ['sent', 'junk'], true);
    const listed = (view: string) => threadsIn([halfJunk], view).map(t => t.id);
    expect(listed('junk')).toEqual([]);
    expect(listed('starred')).toEqual(['half-junk']);
    expect(listed('sent')).toEqual(['half-junk']);
    expect(
      listingOf({ threads: [halfJunk], view: 'unified', q: 'in:junk half', mailboxes: [] }).threads,
    ).toEqual([]);
  });

  it('lists in Junk only what is wholly there, a draft aside, in one mailbox or across them', () => {
    const drafting = thread('drafting', ['junk', 'drafts']);
    expect(threadsIn([drafting], 'junk').map(t => t.id)).toEqual(['drafting']);
    // One mailbox moved its copy to Junk; the other's is still in its inbox.
    const spread: ThreadState = {
      ...thread('spread', ['inbox', 'junk']),
      mailboxes: ['me@x', 'us@y'],
      foldersByMailbox: { 'me@x': ['junk'], 'us@y': ['inbox'] },
    };
    const mailboxes = [{ address: 'me@x' }, { address: 'us@y' }];
    const listed = (q: string) =>
      listingOf({ threads: [spread], view: 'unified', q, mailboxes }).threads.map(t => t.id);
    expect(listed('in:junk mailbox:me@x')).toEqual([]);
    expect(listed('in:junk')).toEqual([]);
    expect(listed('in:inbox mailbox:us@y')).toEqual(['spread']);
  });

  it('shows Junk only in Junk, starred or not', () => {
    expect(idsIn('junk')).toEqual(['junk']);
    expect(['unified', 'starred', 'sent', 'archive', 'trash'].flatMap(idsIn)).not.toContain('junk');
  });
});

describe('olderAvailable', () => {
  const synced = (complete: readonly Folder[]): MailboxSyncState => ({
    status: 'synced',
    at: 0,
    complete,
  });
  const mailboxes = [{ address: 'me@x' }, { address: 'us@y' }];
  // me@x has read its inbox whole; us@y has not, and neither has reached the start of Sent.
  const states = { 'me@x': synced(['inbox']), 'us@y': synced([]) };

  it('asks about the folder the view lists, and starred and an address follow the inbox', () => {
    expect(olderAvailable(states, mailboxes, 'unified')).toBe(true);
    expect(olderAvailable(states, mailboxes, 'starred')).toBe(true);
    expect(olderAvailable(states, mailboxes, 'sent')).toBe(true);
    // Scoped to one address, the other mailbox's unread pages are none of its business.
    expect(olderAvailable(states, mailboxes, 'me@x')).toBe(false);
    expect(olderAvailable(states, mailboxes, 'us@y')).toBe(true);
  });

  it('is false for every mailbox that has not synced, and for an address that is not connected', () => {
    expect(olderAvailable({}, mailboxes, 'unified')).toBe(false);
    expect(olderAvailable({ 'me@x': { status: 'syncing' } }, mailboxes, 'me@x')).toBe(false);
    expect(
      olderAvailable(
        { 'me@x': { status: 'failed', failure: { kind: 'error', detail: 'x' }, at: 0 } },
        mailboxes,
        'me@x',
      ),
    ).toBe(false);
    expect(olderAvailable(states, mailboxes, 'nobody@z')).toBe(false);
  });

  it('hides the control once every mailbox shown has reached the start of the folder', () => {
    const done = { 'me@x': synced(['inbox', 'trash']), 'us@y': synced(['inbox']) };
    expect(olderAvailable(done, mailboxes, 'unified')).toBe(false);
    expect(olderAvailable(done, mailboxes, 'trash')).toBe(true);
    expect(olderAvailable(done, [{ address: 'me@x' }], 'trash')).toBe(false);
  });
});

describe('syncProgressIn', () => {
  const mailboxes = [{ address: 'me@x' }, { address: 'us@y' }];
  const failed: MailboxSyncState = {
    status: 'failed',
    failure: { kind: 'error', detail: 'nope' },
    at: 0,
  };
  const synced: MailboxSyncState = { status: 'synced', at: 0, complete: [] };

  const addresses = (accs: readonly { readonly address: string }[]) => accs.map(a => a.address);

  it('counts a mailbox with no state at all as pending, which is the fresh-login case', () => {
    // The bug: a view asked the single-address question, found nothing, and said "Nothing here
    // yet" through the whole first sync.
    expect(addresses(syncProgressIn({}, mailboxes, 'unified').pending)).toEqual(['me@x', 'us@y']);
  });

  it('narrows to the mailboxes the view draws from', () => {
    const states = { 'me@x': synced, 'us@y': { status: 'syncing' } as const };
    expect(addresses(syncProgressIn(states, mailboxes, 'unified').pending)).toEqual(['us@y']);
    expect(syncProgressIn(states, mailboxes, 'me@x').pending).toEqual([]);
    expect(addresses(syncProgressIn(states, mailboxes, 'us@y').pending)).toEqual(['us@y']);
  });

  it('reports a failure in a view, not only under the address that failed', () => {
    const states = { 'me@x': synced, 'us@y': failed };
    const { pending, failed: bad } = syncProgressIn(states, mailboxes, 'unified');
    expect(pending).toEqual([]);
    expect(addresses(bad.map(entry => entry.mailbox))).toEqual(['us@y']);
    expect(syncProgressIn(states, mailboxes, 'me@x').failed).toEqual([]);
  });
});

describe('neighbourOf', () => {
  const list = ['a', 'b', 'c'].map(id => thread(id, ['inbox']));

  it('moves down the list, up from its foot, and nowhere from a list of one or a thread not in it', () => {
    expect(neighbourOf(list, 'a')?.id).toBe('b');
    expect(neighbourOf(list, 'b')?.id).toBe('c');
    expect(neighbourOf(list, 'c')?.id).toBe('b');
    expect(neighbourOf(list.slice(0, 1), 'a')).toBeUndefined();
    expect(neighbourOf(list, 'elsewhere')).toBeUndefined();
  });
});

describe('the query behind a list', () => {
  const mailboxes = [{ address: 'me@x' }, { address: 'us@y' }];
  const words = (id: string, folders: readonly Folder[]): ThreadState => ({
    ...thread(id, folders),
    subject: `stripe ${id}`,
  });
  const inbox = words('inbox', ['inbox']);
  const archived = words('archived', ['archive']);
  const trashed = words('trashed', ['trash']);
  const junk = words('junk', ['junk']);
  const elsewhere = { ...thread('other', ['inbox']), subject: 'lunch' };
  const threads = [inbox, archived, trashed, junk, elsewhere];
  const idsOf = (query: string | undefined, view = 'unified') =>
    listingOf({ threads: threads, view: view, q: query, mailboxes }).threads.map(({ id }) => id);

  it.each([
    ['unified', 'in:inbox'],
    ['starred', 'is:starred'],
    ['archive', 'in:archive'],
    ['sent', 'in:sent'],
    ['trash', 'in:trash'],
    ['junk', 'in:junk'],
    ['drafts', 'in:drafts'],
    ['me@x', 'in:inbox mailbox:me@x'],
  ])('%s is %s, and that query is that view', (view, query) => {
    expect(queryOfView(view)).toBe(query);
    expect(viewOfQuery(query, mailboxes)).toBe(view);
  });

  it('reads a view’s query whatever its order, case or spacing', () => {
    expect(viewOfQuery('  MAILBOX:ME@X   in:INBOX ', mailboxes)).toBe('me@x');
  });

  it('finds no view for an empty query, which lists everything but Trash', () => {
    expect(viewOfQuery('', mailboxes)).toBeNull();
    expect(viewOfQuery('   ', mailboxes)).toBeNull();
    expect(idsOf('')).toEqual(['inbox', 'archived', 'other']);
    expect(listingOf({ threads: threads, view: 'unified', q: '', mailboxes })).toMatchObject({
      query: '',
      isSearch: true,
    });
  });

  it('shows the inbox for a URL with no query at all', () => {
    expect(listingOf({ threads: threads, view: 'unified', q: undefined, mailboxes })).toMatchObject(
      {
        query: 'in:inbox',
        isSearch: false,
      },
    );
  });

  it('finds no view for anything more than a view’s own query', () => {
    expect(viewOfQuery('in:inbox stripe', mailboxes)).toBeNull();
    expect(viewOfQuery('in:inbox is:starred', mailboxes)).toBeNull();
    expect(viewOfQuery('in:inbox mailbox:stranger@x', mailboxes)).toBeNull();
  });

  it('shows the view for its own query, whichever view the URL names', () => {
    const listing = listingOf({ threads: threads, view: 'sent', q: 'in:trash', mailboxes });
    expect(listing).toMatchObject({ view: 'trash', isSearch: false, query: 'in:trash' });
    expect(listing.threads.map(({ id }) => id)).toEqual(['trashed']);
  });

  it('shows a view’s query with no `?q=`', () => {
    expect(listingOf({ threads: threads, view: 'us@y', q: undefined, mailboxes })).toMatchObject({
      view: 'us@y',
      isSearch: false,
      query: 'in:inbox mailbox:us@y',
    });
  });

  it('searches everything but Trash for bare words, whichever view they were typed over', () => {
    expect(idsOf('stripe')).toEqual(['inbox', 'archived']);
    expect(idsOf('stripe', 'trash')).toEqual(['inbox', 'archived']);
    expect(listingOf({ threads: threads, view: 'unified', q: 'stripe', mailboxes })).toMatchObject({
      isSearch: true,
      view: 'unified',
    });
  });

  it('reaches Trash and Junk only when asked', () => {
    expect(idsOf('in:trash stripe')).toEqual(['trashed']);
    expect(idsOf('in:junk stripe')).toEqual(['junk']);
    expect(idsOf('in:anywhere stripe')).toEqual(['inbox', 'archived', 'trashed', 'junk']);
  });

  it('narrows inside a folder, and rows of one folder act as that folder’s view', () => {
    expect(idsOf('in:inbox stripe')).toEqual(['inbox']);
    expect(
      listingOf({ threads: threads, view: 'unified', q: 'in:trash stripe', mailboxes }).view,
    ).toBe('trash');
  });

  it('follows a pending move, which has reached the folders but not the copies', () => {
    const moved: ThreadState = {
      ...words('moved', ['archive']),
      messages: [
        {
          ...message('moved/1'),
          locations: [{ mailbox: 'me@x', folder: 'inbox', uidValidity: 1, uid: 1 }],
        },
      ],
    };
    expect(
      listingOf({ threads: [moved], view: 'unified', q: 'in:inbox stripe', mailboxes }).threads,
    ).toEqual([]);
  });

  it('shows no row a search alone has found under a view or a query that only says where', () => {
    const found: ThreadState = { ...words('found', ['inbox']), isFoundOnly: true };
    const all = [...threads, found];
    expect(threadsIn(all, 'unified').map(({ id }) => id)).not.toContain('found');
    expect(
      listingOf({ threads: all, view: 'unified', q: '', mailboxes }).threads.map(({ id }) => id),
    ).not.toContain('found');
    expect(
      listingOf({ threads: all, view: 'unified', q: 'stripe', mailboxes }).threads.map(
        ({ id }) => id,
      ),
    ).toContain('found');
  });

  it('joins what the servers answered to what this device matches', () => {
    const hit = { ...thread('hit', ['archive']), subject: 'nothing like it' };
    const rows = listingOf({
      threads: [...threads, hit],
      view: 'unified',
      q: 'stripe',
      mailboxes,
      isHit: ({ id }) => id === 'hit',
    }).threads;
    expect(rows.map(({ id }) => id)).toContain('hit');
  });

  it('shows no search row at or below where the matches read stop, and offers the rest when all have answered', () => {
    const at = (id: string, day: number): ThreadState => ({
      ...words(id, ['archive']),
      messages: [
        {
          ...message(`${id}/1`),
          at: Temporal.PlainDate.from({ year: 2026, month: 1, day }).toZonedDateTime('UTC')
            .epochMilliseconds,
        },
      ],
    });
    const matchFrontier = {
      mailbox: 'me@x',
      folder: 'archive' as const,
      reachedAt: Temporal.Instant.from('2026-01-10T00:00:00Z').epochMilliseconds,
    };
    const listing = (isAnswering: boolean) =>
      listingOf({
        threads: [at('new', 20), at('below', 5)],
        view: 'unified',
        q: 'stripe',
        mailboxes,
        matchFrontier,
        isAnswering,
      });
    expect(listing(false).threads.map(({ id }) => id)).toEqual(['new']);
    expect(listing(false).older).toEqual(matchFrontier);
    expect(listing(true).threads.map(({ id }) => id)).toEqual(['new']);
    expect(listing(true).older).toBeNull();
  });

  it('shows nothing at or below where the soonest-stopping folder has reached', () => {
    const at = (id: string, day: number): ThreadState => ({
      ...thread(id, ['archive']),
      messages: [
        {
          ...message(`${id}/1`),
          at: Temporal.PlainDate.from({ year: 2026, month: 1, day }).toZonedDateTime('UTC')
            .epochMilliseconds,
        },
      ],
    });
    const summary = (uid: number, internalDate: string) => ({
      seq: uid,
      uid,
      flags: [],
      internalDate,
      size: 1,
      envelope: null,
      references: [],
      gmailThreadId: null,
      attachmentNames: [],
    });
    const windows = [
      {
        mailbox: 'me@x',
        folder: 'inbox' as const,
        isComplete: false,
        summaries: [summary(5, '10-Jan-2026 00:00:00 +0000')],
      },
      {
        mailbox: 'me@x',
        folder: 'archive' as const,
        isComplete: false,
        summaries: [summary(1, '02-Jan-2026 00:00:00 +0000')],
      },
    ];
    const listing = listingOf({
      threads: [at('new', 20), at('below', 5)],
      view: 'unified',
      q: '',
      mailboxes,
      windows,
    });
    expect(listing.threads.map(({ id }) => id)).toEqual(['new']);
    expect(listing.older).toMatchObject({ mailbox: 'me@x', folder: 'inbox' });
    // A folder the query does not cover says nothing about its list.
    expect(
      listingOf({
        threads: [at('new', 20), at('below', 5)],
        view: 'unified',
        q: 'in:archive mailbox:me@x',
        mailboxes,
        windows,
      }).older,
    ).toMatchObject({ folder: 'archive' });
  });

  it("does not clip the empty box to the server's Drafts, which the list never shows", () => {
    const windows = windowsOf(
      {
        'me@x': {
          inbox: { uidValidity: 1, summaries: [] },
          drafts: { uidValidity: 1, summaries: [] },
        },
      },
      (_mailbox, folder) => folder !== 'drafts',
    );
    const listing = listingOf({
      threads: [thread('inbox', ['inbox'])],
      view: 'unified',
      q: '',
      mailboxes,
      windows,
    });
    expect(listing.threads.map(({ id }) => id)).toEqual(['inbox']);
    expect(listing.older).toBeNull();
  });

  it('lists a query that only says where, with nothing a server could be asked', () => {
    expect(idsOf('in:anywhere')).toEqual(['inbox', 'archived', 'trashed', 'junk', 'other']);
  });

  it('gives an address with no mailbox an error, not an empty answer', () => {
    const listing = listingOf({
      threads: threads,
      view: 'unified',
      q: 'mailbox:alias@x',
      mailboxes,
    });
    expect(listing.threads).toEqual([]);
    expect(listing.error).toContain('alias@x has no mailbox');
  });
});
