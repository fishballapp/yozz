import { describe, expect, it } from 'vitest';
import { applyOps, type MoveTarget, type PendingOp } from './reconcile.ts';
import type { Folder, Message, ThreadState } from './thread.ts';
import { threadsIn, unreadCount } from './views.ts';

/** A pending op is what the views show until the sync lands, so its effect is checked through them. */

const message = (id: string): Message => ({
  id,
  fromName: 'x',
  fromAddress: 'x@x',
  toAddress: 'me@x',
  at: 1,
  body: [],
});

const thread = (id: string, folders: readonly Folder[]): ThreadState => ({
  id,
  accounts: ['me@x'],
  foldersByAccount: { 'me@x': folders },
  subject: id,
  messages: [message(`${id}/1`)],
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders,
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
