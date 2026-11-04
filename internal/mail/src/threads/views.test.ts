import { describe, expect, it } from 'vitest';
import type { MailboxSyncState } from './sync.ts';
import type { Folder, Message, ThreadState } from './thread.ts';
import { neighbourOf, olderAvailable, syncProgressIn, threadsIn } from './views.ts';

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
  const all = [inbox, sentOnly, archived, trashed, halfTrashed];

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
