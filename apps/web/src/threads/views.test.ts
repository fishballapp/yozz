import { describe, expect, it } from 'vitest';
import { applyOps, type MoveTarget, type PendingOp } from './reconcile';
import type { AccountSyncState } from './sync';
import type { Folder, Message, ThreadState } from './thread';
import { neighbourOf, olderAvailable, syncProgressIn, threadsIn, unreadCount } from './views';

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

describe('a pending move in an address view', () => {
  const move = (threadId: string, account: string, to: MoveTarget): PendingOp => ({
    id: `${threadId}:${account}:${to}`,
    account,
    threadId,
    change: { kind: 'move', to },
    retireAtSyncSeq: null,
  });
  const unreadIn = (foldersByAccount: Readonly<Record<string, readonly Folder[]>>) => ({
    ...thread('t', ['inbox']),
    accounts: Object.keys(foldersByAccount),
    foldersByAccount,
    isUnread: true,
  });
  const idsIn = (threads: readonly ThreadState[], mailbox: string) =>
    threadsIn(threads, mailbox).map(t => t.id);

  it('leaves and returns at once, and the address’s unread count follows', () => {
    const base = [unreadIn({ 'me@x': ['inbox'] })];
    expect(unreadCount(base, 'me@x')).toBe(1);

    const archived = applyOps(base, [move('t', 'me@x', 'archive')]);
    expect(idsIn(archived, 'me@x')).toEqual([]);
    expect(unreadCount(archived, 'me@x')).toBe(0);
    expect(idsIn(archived, 'archive')).toEqual(['t']);

    const restored = applyOps(base, [move('t', 'me@x', 'archive'), move('t', 'me@x', 'inbox')]);
    expect(idsIn(restored, 'me@x')).toEqual(['t']);
    expect(unreadCount(restored, 'me@x')).toBe(1);
  });

  it('archives one account’s copy and leaves the other’s inbox, and the unified one, showing it', () => {
    const base = [unreadIn({ 'me@x': ['inbox'], 'you@y': ['inbox'] })];

    const one = applyOps(base, [move('t', 'me@x', 'archive')]);
    expect(idsIn(one, 'me@x')).toEqual([]);
    expect(idsIn(one, 'you@y')).toEqual(['t']);
    expect(idsIn(one, 'unified')).toEqual(['t']);
    expect(unreadCount(one, 'me@x')).toBe(0);
    expect(unreadCount(one, 'you@y')).toBe(1);

    const both = applyOps(base, [move('t', 'me@x', 'archive'), move('t', 'you@y', 'archive')]);
    expect(idsIn(both, 'you@y')).toEqual([]);
    expect(idsIn(both, 'unified')).toEqual([]);
    expect(idsIn(both, 'archive')).toEqual(['t']);
    expect(unreadCount(both, 'unified')).toBe(0);
  });
});
