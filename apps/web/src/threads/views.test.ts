import { describe, expect, it } from 'vitest';
import type { AccountSyncState } from './sync';
import type { Folder, Message, ThreadState } from './thread';
import { olderAvailable, syncProgressIn, threadsIn } from './views';

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
  accounts: ['me@x'],
  foldersByAccount: { 'me@x': folders },
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

  const idsIn = (mailbox: string) => threadsIn(all, mailbox).map(t => t.id);

  it('keeps a thread of only your own sent mail out of the inbox, and the bin out of every live view', () => {
    expect(idsIn('unified')).toEqual(['inbox', 'half-trashed']);
    expect(idsIn('starred')).toEqual(['inbox', 'archived']);
    expect(idsIn('sent')).toEqual(['inbox', 'sent-only', 'archived']);
  });

  it('shows archived mail only in Archive, and everything with a binned message in Trash', () => {
    expect(idsIn('archive')).toEqual(['archived']);
    expect(idsIn('trash')).toEqual(['trashed', 'half-trashed']);
  });
});

describe('olderAvailable', () => {
  const synced = (complete: readonly Folder[]): AccountSyncState => ({
    status: 'synced',
    at: 0,
    complete,
  });
  const accounts = [{ address: 'me@x' }, { address: 'us@y' }];
  // me@x has read its inbox whole; us@y has not, and neither has reached the start of Sent.
  const states = { 'me@x': synced(['inbox']), 'us@y': synced([]) };

  it('asks about the folder the view lists, and starred and an address follow the inbox', () => {
    expect(olderAvailable(states, accounts, 'unified')).toBe(true);
    expect(olderAvailable(states, accounts, 'starred')).toBe(true);
    expect(olderAvailable(states, accounts, 'sent')).toBe(true);
    // Scoped to one address, the other account's unread pages are none of its business.
    expect(olderAvailable(states, accounts, 'me@x')).toBe(false);
    expect(olderAvailable(states, accounts, 'us@y')).toBe(true);
  });

  it('is false for every account that has not synced, and for an address that is not connected', () => {
    expect(olderAvailable({}, accounts, 'unified')).toBe(false);
    expect(olderAvailable({ 'me@x': { status: 'syncing' } }, accounts, 'me@x')).toBe(false);
    expect(
      olderAvailable(
        { 'me@x': { status: 'failed', failure: { kind: 'error', detail: 'x' }, at: 0 } },
        accounts,
        'me@x',
      ),
    ).toBe(false);
    expect(olderAvailable(states, accounts, 'nobody@z')).toBe(false);
  });

  it('hides the control once every account shown has reached the start of the folder', () => {
    const done = { 'me@x': synced(['inbox', 'trash']), 'us@y': synced(['inbox']) };
    expect(olderAvailable(done, accounts, 'unified')).toBe(false);
    expect(olderAvailable(done, accounts, 'trash')).toBe(true);
    expect(olderAvailable(done, [{ address: 'me@x' }], 'trash')).toBe(false);
  });
});

describe('syncProgressIn', () => {
  const accounts = [{ address: 'me@x' }, { address: 'us@y' }];
  const failed: AccountSyncState = {
    status: 'failed',
    failure: { kind: 'error', detail: 'nope' },
    at: 0,
  };
  const synced: AccountSyncState = { status: 'synced', at: 0, complete: [] };

  const addresses = (accs: readonly { readonly address: string }[]) => accs.map(a => a.address);

  it('counts an account with no state at all as pending, which is the fresh-login case', () => {
    // The bug: a view asked the single-address question, found nothing, and said "Nothing here
    // yet" through the whole first sync.
    expect(addresses(syncProgressIn({}, accounts, 'unified').pending)).toEqual(['me@x', 'us@y']);
  });

  it('narrows to the accounts the mailbox draws from', () => {
    const states = { 'me@x': synced, 'us@y': { status: 'syncing' } as const };
    expect(addresses(syncProgressIn(states, accounts, 'unified').pending)).toEqual(['us@y']);
    expect(syncProgressIn(states, accounts, 'me@x').pending).toEqual([]);
    expect(addresses(syncProgressIn(states, accounts, 'us@y').pending)).toEqual(['us@y']);
  });

  it('reports a failure in a view, not only under the address that failed', () => {
    const states = { 'me@x': synced, 'us@y': failed };
    const { pending, failed: bad } = syncProgressIn(states, accounts, 'unified');
    expect(pending).toEqual([]);
    expect(addresses(bad.map(entry => entry.account))).toEqual(['us@y']);
    expect(syncProgressIn(states, accounts, 'me@x').failed).toEqual([]);
  });
});
