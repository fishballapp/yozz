import { FOLDERS, type Folder } from './thread';

/**
 * Rendered mail is `applyOps(base, ops)`. An op leaves the list when the server refused it, or
 * when a sync of that account that started after the ack lands (`retireAtSyncSeq`); every IMAP
 * command of an account runs on one serial queue, so such a sync observed the server after the
 * command. See DECISIONS.md, 2026-08-27.
 */

/** Sent is not one: nothing moves mail into the Sent folder. */
export type MoveTarget = 'inbox' | 'archive' | 'trash';

/** Archiving takes the inbox only; the bin takes everything. */
export const MOVE_SOURCES: Record<MoveTarget, readonly Folder[]> = {
  archive: ['inbox'],
  trash: ['inbox', 'sent', 'archive'],
  inbox: ['archive', 'trash'],
};

/** The destination in, the sources out, the rest as they were. */
export const foldersAfterMove = (folders: readonly Folder[], to: MoveTarget): readonly Folder[] =>
  FOLDERS.filter(
    folder => folder === to || (folders.includes(folder) && !MOVE_SOURCES[to].includes(folder)),
  );

export type PendingChange =
  | { readonly kind: 'flag'; readonly key: 'isUnread' | 'isStarred'; readonly value: boolean }
  /** The target, not the folders at click time, so two stacked moves compose. */
  | { readonly kind: 'move'; readonly to: MoveTarget };

export type PendingOp = {
  readonly id: string;
  readonly account: string;
  readonly threadId: string;
  readonly change: PendingChange;
  /** `null` until the server has done it; then the seq of the first sync that may retire it. */
  readonly retireAtSyncSeq: number | null;
};

type Reconcilable = {
  readonly id: string;
  readonly isUnread: boolean;
  readonly isStarred: boolean;
  readonly folders: readonly Folder[];
};

const applyChange = <T extends Reconcilable>(thread: T, change: PendingChange): T =>
  change.kind === 'flag'
    ? { ...thread, [change.key]: change.value }
    : { ...thread, folders: foldersAfterMove(thread.folders, change.to) };

/** Each thread's ops in the order they were made. */
export const applyOps = <T extends Reconcilable>(
  threads: readonly T[],
  ops: readonly PendingOp[],
): readonly T[] => {
  if (ops.length === 0) return threads;
  const byThread = Map.groupBy(ops, op => op.threadId);
  return threads.map(thread => {
    const own = byThread.get(thread.id);
    return own === undefined
      ? thread
      : own.reduce((current, op) => applyChange(current, op.change), thread);
  });
};

/** What is left after a sync of `account` that started as sync number `completedSeq` has landed. */
export const retireOps = (
  ops: readonly PendingOp[],
  account: string,
  completedSeq: number,
): readonly PendingOp[] =>
  ops.filter(
    op =>
      op.account !== account || op.retireAtSyncSeq === null || op.retireAtSyncSeq > completedSeq,
  );
