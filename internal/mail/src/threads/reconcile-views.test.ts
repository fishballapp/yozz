import { describe, expect, it } from 'vitest';
import { applyOps, type MoveTarget, type PendingOp } from './reconcile.ts';
import { threadsFromMailboxes } from './summaries.ts';
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
  mailboxes: ['me@x'],
  foldersByMailbox: { 'me@x': folders },
  subject: id,
  messages: [message(`${id}/1`)],
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders,
});

describe('a pending move in an address view', () => {
  const move = (threadId: string, mailbox: string, to: MoveTarget): PendingOp => ({
    id: `${threadId}:${mailbox}:${to}`,
    mailbox,
    threadId,
    change: { kind: 'move', to },
    retireAtSyncSeq: null,
  });
  const unreadIn = (foldersByMailbox: Readonly<Record<string, readonly Folder[]>>) => ({
    ...thread('t', ['inbox']),
    mailboxes: Object.keys(foldersByMailbox),
    foldersByMailbox,
    isUnread: true,
  });
  const idsIn = (threads: readonly ThreadState[], view: string) =>
    threadsIn(threads, view).map(t => t.id);

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

  it('archives one mailbox’s copy and leaves the other’s inbox, and the unified one, showing it', () => {
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

describe('a move into Junk and out again, through the syncs that confirm it', () => {
  const summary = (folder: Folder) => ({
    seq: 1,
    uid: folder === 'junk' ? 40 : 7,
    flags: ['\\Seen'],
    internalDate: '23-Aug-2026 09:00:00 +0000',
    size: 100,
    envelope: {
      date: 'Sun, 23 Aug 2026 09:00:00 +0000',
      subject: 'Invoice 42',
      subjectRaw: null,
      from: [{ name: null, mailbox: 'billing', host: 'example.com' }],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
      inReplyTo: null,
      messageId: '<inv-42@example.com>',
    },
    references: [],
    gmailThreadId: null,
    attachmentNames: [],
  });
  const synced = (folder: Folder) =>
    threadsFromMailboxes({
      'me@x': { [folder]: { uidValidity: 1, summaries: [summary(folder)] } },
    });
  const op = (threadId: string, to: MoveTarget): PendingOp => ({
    id: `${threadId}:${to}`,
    mailbox: 'me@x',
    threadId,
    change: { kind: 'move', to },
    retireAtSyncSeq: 1,
  });

  it('keeps the id the reader and the next write name, before the sync and after it', () => {
    const [before] = synced('inbox');
    if (before === undefined) throw new Error('no thread');
    // Moved to Junk: the pending op over the old base, then the base the confirming sync reads.
    const [pending] = applyOps([before], [op(before.id, 'junk')]);
    const [landed] = synced('junk');
    expect([pending?.id, landed?.id]).toEqual([before.id, before.id]);
    expect(landed?.messages[0]?.id).toBe(before.messages[0]?.id);
    // Out of Junk, then Archive before that sync lands: both ops still name the thread.
    const [archived] = applyOps(
      [landed ?? before],
      [op(before.id, 'inbox'), op(before.id, 'archive')],
    );
    expect(archived?.folders).toEqual(['archive']);
  });
});
