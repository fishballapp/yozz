import { describe, expect, it } from 'vitest';
import type { FolderSync } from './cache.ts';
import {
  applyOps,
  canMoveTo,
  flagTargets,
  foldersAfterMove,
  junkReadiness,
  movesOffered,
  type PendingOp,
  retireOps,
} from './reconcile.ts';
import type { Folder } from './thread.ts';

const thread = (
  id: string,
  folders: readonly Folder[],
  foldersByMailbox: Readonly<Record<string, readonly Folder[]>> = { 'me@x': folders },
  flags = {},
) => ({
  id,
  isUnread: true,
  isStarred: false,
  folders,
  foldersByMailbox,
  ...flags,
});

const op = (
  threadId: string,
  change: PendingOp['change'],
  extra: Partial<PendingOp> = {},
): PendingOp => ({
  id: `${threadId}:${JSON.stringify(change)}`,
  mailbox: 'me@x',
  threadId,
  change,
  retireAtSyncSeq: null,
  ...extra,
});

describe('canMoveTo', () => {
  it.each([
    [['inbox'], 'archive', true],
    [['inbox', 'sent'], 'archive', true],
    [['sent'], 'archive', false],
    [['trash'], 'archive', false],
    [['sent'], 'trash', true],
    [['inbox'], 'trash', true],
    [['archive'], 'trash', true],
    [['trash'], 'trash', false],
    [['archive'], 'inbox', true],
    [['trash'], 'inbox', true],
    [['inbox'], 'inbox', false],
    [['sent'], 'inbox', false],
    [['junk'], 'inbox', true],
    [['inbox'], 'junk', true],
    [['archive'], 'junk', true],
    [['sent'], 'junk', false],
    [['trash'], 'junk', false],
    [['junk'], 'junk', false],
    [['junk'], 'trash', true],
    [[], 'archive', false],
  ] as const)('%j can move to %s: %s', (folders, to, expected) => {
    expect(canMoveTo(folders, to)).toBe(expected);
  });
});

describe('foldersAfterMove', () => {
  it.each([
    [['inbox', 'sent'], 'archive', ['sent', 'archive']],
    [['inbox', 'sent', 'archive'], 'trash', ['trash']],
    [['archive'], 'inbox', ['inbox']],
    [['trash'], 'inbox', ['inbox']],
    [['sent'], 'archive', ['sent', 'archive']],
    [['inbox', 'sent', 'archive'], 'junk', ['sent', 'junk']],
    [['junk'], 'inbox', ['inbox']],
  ] as const)('%j → %s = %j', (folders, to, expected) => {
    expect(foldersAfterMove(folders, to)).toEqual(expected);
  });
});

describe('movesOffered', () => {
  const junkOn = { 'me@x': true };

  it('offers Junk on what arrived, only where its mailbox has a Junk folder', () => {
    expect(movesOffered(thread('t', ['inbox', 'sent']), junkOn).canMoveToJunk).toBe(true);
    expect(movesOffered(thread('t', ['archive']), junkOn).canMoveToJunk).toBe(true);
    expect(movesOffered(thread('t', ['inbox']), { 'me@x': false }).canMoveToJunk).toBe(false);
    expect(movesOffered(thread('t', ['sent']), junkOn).canMoveToJunk).toBe(false);
    // Two mailboxes hold it: the one with a Junk folder holds only what Junk would not take.
    const spread = thread('t', ['inbox', 'sent'], { 'me@x': ['sent'], 'you@y': ['inbox'] });
    expect(movesOffered(spread, { ...junkOn, 'you@y': false }).canMoveToJunk).toBe(false);
  });

  it('waits for every mailbox holding a copy to answer LIST, so no copy stays behind unseen', () => {
    const spread = thread('t', ['inbox'], { 'me@x': ['inbox'], 'you@y': ['inbox'] });
    expect(junkReadiness(spread, junkOn)).toBe('unknown');
    expect(movesOffered(spread, junkOn).canMoveToJunk).toBe(false);
    // One answered that it has none: its copy stays, and the other's moves.
    expect(junkReadiness(spread, { ...junkOn, 'you@y': false })).toBe('ready');
    expect(junkReadiness(spread, { 'me@x': false, 'you@y': false })).toBe('none');
  });

  it('offers out of Junk and Delete on Junk, and Restore alone replaces out of Junk', () => {
    expect(movesOffered(thread('t', ['junk']), junkOn)).toEqual({
      canRestore: false,
      canArchive: false,
      canMoveToInbox: false,
      canMoveToJunk: false,
      canMoveOutOfJunk: true,
      canDelete: true,
    });
    expect(movesOffered(thread('t', ['trash', 'junk']), junkOn).canMoveOutOfJunk).toBe(false);
    // One inbox button: Move to inbox takes Junk's copies back with Archive's.
    const filed = movesOffered(thread('t', ['archive', 'junk']), junkOn);
    expect([filed.canMoveToInbox, filed.canMoveOutOfJunk]).toEqual([true, false]);
  });
});

describe('applyOps', () => {
  it('returns the same array when there is nothing pending', () => {
    const threads = [thread('a', ['inbox'])];
    expect(applyOps(threads, [])).toBe(threads);
  });

  it('lays each thread’s ops over the base in order, and ignores ids the base lacks', () => {
    const base = [thread('a', ['inbox', 'sent']), thread('b', ['inbox'])];
    const result = applyOps(base, [
      op('a', { kind: 'move', to: 'archive' }),
      op('a', { kind: 'flag', key: 'isUnread', value: false }),
      op('a', { kind: 'move', to: 'trash' }),
      op('gone', { kind: 'move', to: 'trash' }),
    ]);
    expect(result[0]).toEqual({
      id: 'a',
      isUnread: false,
      isStarred: false,
      folders: ['trash'],
      foldersByMailbox: { 'me@x': ['trash'] },
    });
    expect(result[1]).toBe(base[1]);
  });

  it('keeps masking after a sync that has not caught up replaces the base', () => {
    const ops = [op('a', { kind: 'move', to: 'archive' })];
    const before = applyOps([thread('a', ['inbox'])], ops);
    const staleSync = applyOps([thread('a', ['inbox'])], ops);
    expect(before[0]?.folders).toEqual(['archive']);
    expect(before[0]?.foldersByMailbox['me@x']).toEqual(['archive']);
    expect(staleSync[0]?.folders).toEqual(['archive']);
    expect(staleSync[0]?.foldersByMailbox['me@x']).toEqual(['archive']);
  });

  it('moves only the op’s own mailbox, and the thread is in every folder any mailbox holds', () => {
    const shared = thread('a', ['inbox'], { 'me@x': ['inbox'], 'you@y': ['inbox'] });
    const [result] = applyOps([shared], [op('a', { kind: 'move', to: 'archive' })]);
    expect(result?.foldersByMailbox).toEqual({ 'me@x': ['archive'], 'you@y': ['inbox'] });
    expect(result?.folders).toEqual(['inbox', 'archive']);
  });

  it('invents no copy for a mailbox that holds none', () => {
    const base = [thread('a', ['inbox'])];
    const [result] = applyOps(base, [op('a', { kind: 'move', to: 'inbox' }, { mailbox: 'you@y' })]);
    expect(result).toBe(base[0]);
  });
});

describe('retireOps', () => {
  const pending = op('a', { kind: 'flag', key: 'isStarred', value: true });
  const ackedEarly = op('b', { kind: 'move', to: 'archive' }, { retireAtSyncSeq: 3 });
  const ackedLate = op('c', { kind: 'move', to: 'archive' }, { retireAtSyncSeq: 5 });
  const other = op('d', { kind: 'move', to: 'archive' }, { mailbox: 'you@y', retireAtSyncSeq: 1 });
  const ops = [pending, ackedEarly, ackedLate, other];

  it('retires only ops acked before the completed sync started, for that mailbox', () => {
    expect(retireOps(ops, 'me@x', 3)).toEqual([pending, ackedLate, other]);
    expect(retireOps(ops, 'me@x', 4)).toEqual([pending, ackedLate, other]);
    expect(retireOps(ops, 'me@x', 5)).toEqual([pending, other]);
  });

  it('never retires an op the server has not answered', () => {
    expect(retireOps([pending], 'me@x', 999)).toEqual([pending]);
  });
});

describe('flagTargets', () => {
  const mark = (name: string, uidValidity: number): FolderSync => ({
    name,
    uidValidity,
    lastUid: 99,
    complete: false,
  });

  it('is one target per folder, named and numbered by its sync mark', () => {
    const marks = new Map<Folder, FolderSync | null>([
      ['inbox', mark('INBOX', 7)],
      ['sent', mark('Sent Items', 3)],
    ]);
    expect(
      flagTargets(
        [
          { folder: 'inbox', uidValidity: 7, uid: 4 },
          { folder: 'sent', uidValidity: 3, uid: 9 },
          { folder: 'inbox', uidValidity: 7, uid: 5 },
        ],
        marks,
      ),
    ).toEqual([
      { folder: 'inbox', folderName: 'INBOX', uidValidity: 7, uids: [4, 5] },
      { folder: 'sent', folderName: 'Sent Items', uidValidity: 3, uids: [9] },
    ]);
  });

  it('refuses copies read under another UIDVALIDITY, or in a folder never synced', () => {
    const marks = new Map<Folder, FolderSync | null>([['inbox', mark('INBOX', 8)]]);
    expect(() => flagTargets([{ folder: 'inbox', uidValidity: 7, uid: 4 }], marks)).toThrow(
      'inbox was renumbered',
    );
    expect(() => flagTargets([{ folder: 'archive', uidValidity: 7, uid: 4 }], marks)).toThrow(
      'archive has not synced',
    );
  });
});
