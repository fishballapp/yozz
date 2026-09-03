import { describe, expect, it } from 'vitest';
import { applyOps, foldersAfterMove, type PendingOp, retireOps } from './reconcile';
import type { Folder } from './thread';

const thread = (id: string, folders: readonly Folder[], flags = {}) => ({
  id,
  isUnread: true,
  isStarred: false,
  folders,
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
    expect(result[0]).toEqual({ id: 'a', isUnread: false, isStarred: false, folders: ['trash'] });
    expect(result[1]).toBe(base[1]);
  });

  it('keeps masking after a sync that has not caught up replaces the base', () => {
    const ops = [op('a', { kind: 'move', to: 'archive' })];
    const before = applyOps([thread('a', ['inbox'])], ops);
    const staleSync = applyOps([thread('a', ['inbox'])], ops);
    expect(before[0]?.folders).toEqual(['archive']);
    expect(staleSync[0]?.folders).toEqual(['archive']);
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
