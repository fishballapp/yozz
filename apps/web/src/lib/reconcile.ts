import { FOLDERS, type Folder } from './thread';

/**
 * How what the user asked for is laid over what the server last said.
 *
 * The store keeps a BASE (threads exactly as the last sync, hydrate or page of older mail produced
 * them) and a list of PENDING OPS (flag writes and moves the user made that the base does not show
 * yet). What is rendered is always `applyOps(base, ops)`. A sync may replace the base whenever it
 * likes; it cannot lose an op, because the op is not in the base — it is re-applied on top.
 *
 * An op leaves the list by definition, never by guessing about ordering:
 * - the server refused it → removed at once, and the base shows through;
 * - the server did it → `retireAtSyncSeq` is set to the seq the NEXT sync will start with, and the
 *   op is retired by the first sync of that account to complete with a seq at or past it. Every
 *   IMAP command of an account runs on one serial queue, so such a sync necessarily observed the
 *   server after the command ran, and its base already agrees with the op.
 */

/** Where a move can send a thread. Sent is not one: nothing moves mail INTO the Sent folder. */
export type MoveTarget = 'inbox' | 'archive' | 'trash';

/**
 * Which folders a move empties into its destination. Archiving takes the inbox only, so the Sent
 * copies of the conversation stay where they are; the bin takes everything, because deleting half
 * a conversation is not what "delete" means to anyone.
 */
export const MOVE_SOURCES: Record<MoveTarget, readonly Folder[]> = {
  archive: ['inbox'],
  trash: ['inbox', 'sent', 'archive'],
  inbox: ['archive', 'trash'],
};

/** A thread's folders after a move: the destination in, the sources out, the rest as they were. */
export const foldersAfterMove = (folders: readonly Folder[], to: MoveTarget): readonly Folder[] =>
  FOLDERS.filter(
    folder => folder === to || (folders.includes(folder) && !MOVE_SOURCES[to].includes(folder)),
  );

export type PendingChange =
  | { readonly kind: 'flag'; readonly key: 'isUnread' | 'isStarred'; readonly value: boolean }
  /** The target, not the folders computed at click time, so two stacked moves compose. */
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

/** The base with every pending op laid over it, each thread's ops in the order they were made. */
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
