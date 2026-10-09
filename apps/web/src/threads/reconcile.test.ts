import { describe, expect, it } from 'vitest';
import { applyOps, canMoveTo, foldersAfterMove, type PendingOp, retireOps } from './reconcile';
import type { Folder } from './thread';

const thread = (
  id: string,
  folders: readonly Folder[],
  foldersByAccount: Readonly<Record<string, readonly Folder[]>> = { 'me@x': folders },
  flags = {},
) => ({
  id,
  isUnread: true,
  isStarred: false,
  folders,
  foldersByAccount,
  ...flags,
});

const op = (
  threadId: string,
  change: PendingOp['change'],
  extra: Partial<PendingOp> = {},
): PendingOp => ({
  id: `${threadId}:${JSON.stringify(change)}`,
  account: 'me@x',
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
  ] as const)('%j → %s = %j', (folders, to, expected) => {
    expect(foldersAfterMove(folders, to)).toEqual(expected);
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
      foldersByAccount: { 'me@x': ['trash'] },
    });
    expect(result[1]).toBe(base[1]);
  });

  it('keeps masking after a sync that has not caught up replaces the base', () => {
    const ops = [op('a', { kind: 'move', to: 'archive' })];
    const before = applyOps([thread('a', ['inbox'])], ops);
    const staleSync = applyOps([thread('a', ['inbox'])], ops);
    expect(before[0]?.folders).toEqual(['archive']);
    expect(before[0]?.foldersByAccount['me@x']).toEqual(['archive']);
    expect(staleSync[0]?.folders).toEqual(['archive']);
    expect(staleSync[0]?.foldersByAccount['me@x']).toEqual(['archive']);
  });

  it('moves only the op’s own account, and the thread is in every folder any account holds', () => {
    const shared = thread('a', ['inbox'], { 'me@x': ['inbox'], 'you@y': ['inbox'] });
    const [result] = applyOps([shared], [op('a', { kind: 'move', to: 'archive' })]);
    expect(result?.foldersByAccount).toEqual({ 'me@x': ['archive'], 'you@y': ['inbox'] });
    expect(result?.folders).toEqual(['inbox', 'archive']);
  });

  it('invents no copy for an account that holds none', () => {
    const base = [thread('a', ['inbox'])];
    const [result] = applyOps(base, [op('a', { kind: 'move', to: 'inbox' }, { account: 'you@y' })]);
    expect(result).toBe(base[0]);
  });
});

describe('retireOps', () => {
  const pending = op('a', { kind: 'flag', key: 'isStarred', value: true });
  const ackedEarly = op('b', { kind: 'move', to: 'archive' }, { retireAtSyncSeq: 3 });
  const ackedLate = op('c', { kind: 'move', to: 'archive' }, { retireAtSyncSeq: 5 });
  const other = op('d', { kind: 'move', to: 'archive' }, { account: 'you@y', retireAtSyncSeq: 1 });
  const ops = [pending, ackedEarly, ackedLate, other];

  it('retires only ops acked before the completed sync started, for that account', () => {
    expect(retireOps(ops, 'me@x', 3)).toEqual([pending, ackedLate, other]);
    expect(retireOps(ops, 'me@x', 4)).toEqual([pending, ackedLate, other]);
    expect(retireOps(ops, 'me@x', 5)).toEqual([pending, other]);
  });

  it('never retires an op the server has not answered', () => {
    expect(retireOps([pending], 'me@x', 999)).toEqual([pending]);
  });
});
