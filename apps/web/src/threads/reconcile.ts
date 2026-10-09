import { FOLDERS, type Folder } from './thread';

/**
 * An op leaves the list when the server refused it, or when a sync of that account that started
 * after the ack lands (`retireAtSyncSeq`); every IMAP command of an account runs on one serial
 * queue, so such a sync observed the server after the command. See DECISIONS.md, 2026-08-27.
 */

/** Sent is not one: nothing moves mail into the Sent folder. */
export type MoveTarget = 'inbox' | 'archive' | 'trash';

/** Archiving takes the inbox only; the bin takes everything. */
export const MOVE_SOURCES: Record<MoveTarget, readonly Folder[]> = {
  archive: ['inbox'],
  trash: ['inbox', 'sent', 'archive'],
  inbox: ['archive', 'trash'],
};

/** A move can only act when the conversation holds a copy in one of that target's source folders. */
export const canMoveTo = (folders: readonly Folder[], to: MoveTarget): boolean =>
  MOVE_SOURCES[to].some(source => folders.includes(source));

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
  readonly foldersByAccount: Readonly<Record<string, readonly Folder[]>>;
};

const applyChange = <T extends Reconcilable>(thread: T, op: PendingOp): T => {
  if (op.change.kind === 'flag') {
    return { ...thread, [op.change.key]: op.change.value };
  }
  const held = thread.foldersByAccount[op.account];
  // A sync can leave the account holding no copy any more; moving nothing must not invent one.
  if (held === undefined) return thread;
  const foldersByAccount = {
    ...thread.foldersByAccount,
    [op.account]: foldersAfterMove(held, op.change.to),
  };
  // A move reaches only its own account's copies; the thread is wherever any account holds one.
  const folders = FOLDERS.filter(folder =>
    Object.values(foldersByAccount).some(accountFolders => accountFolders.includes(folder)),
  );
  return { ...thread, folders, foldersByAccount };
};

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
      : own.reduce((current, op) => applyChange(current, op), thread);
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

/**
 * After a UIDVALIDITY change the server may hand the same uid to different mail, and the threads
 * React is still rendering predate the sync that cleared the cache. The op is dropped and its error
 * surfaces; the running sync replaces the base.
 */
export const assertSameUidValidity = (
  folder: Folder,
  current: number,
  locations: readonly { readonly uidValidity: number }[],
) => {
  if (locations.every(location => location.uidValidity === current)) return;
  throw new Error(`${folder} was renumbered; reopen the conversation`);
};
