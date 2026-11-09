import type { FolderSync } from './cache.ts';
import type { FlagTarget } from './sync.ts';
import { FOLDERS, type Folder, type Location, renumberedText } from './thread.ts';

/**
 * An op leaves the list when the server refused it, or when a sync of that mailbox that started
 * after the ack lands (`retireAtSyncSeq`); every IMAP command of a mailbox runs on one serial
 * queue, so such a sync observed the server after the command. See DECISIONS.md, 2026-08-27.
 */

/** Sent is not one: nothing moves mail into the Sent folder. */
export type MoveTarget = 'inbox' | 'archive' | 'trash' | 'junk';

/**
 * Archiving takes the inbox only; Trash takes everything; the inbox takes back what any other move
 * filed. Junk takes what arrived and is still kept: your own Sent copies are not spam, and what is in
 * Trash is restored first.
 */
export const MOVE_SOURCES: Record<MoveTarget, readonly Folder[]> = {
  archive: ['inbox'],
  trash: ['inbox', 'sent', 'archive', 'junk'],
  inbox: ['archive', 'trash', 'junk'],
  junk: ['inbox', 'archive'],
};

/** A move can only act when the conversation holds a copy in one of that target's source folders. */
export const canMoveTo = (folders: readonly Folder[], to: MoveTarget): boolean =>
  MOVE_SOURCES[to].some(source => folders.includes(source));

/**
 * Whether each mailbox's server lists a Junk folder, by address; absent until its `LIST` has answered
 * this session. YOZZ never creates one.
 */
export type JunkFolders = Readonly<Record<string, boolean>>;

/**
 * Whether Junk can take a conversation: `ready` when every mailbox holding a copy Junk would take has
 * answered and one of them has a Junk folder (the others' copies stay), `unknown` while one has not
 * answered, so a move never leaves its copy behind unseen, and `none` when no such mailbox has one.
 */
export const junkReadiness = (
  { foldersByMailbox }: { readonly foldersByMailbox: Readonly<Record<string, readonly Folder[]>> },
  junkFolders: JunkFolders,
): 'ready' | 'unknown' | 'none' => {
  const holding = Object.entries(foldersByMailbox)
    .filter(([, folders]) => canMoveTo(folders, 'junk'))
    .map(([mailbox]) => junkFolders[mailbox]);
  if (holding.includes(undefined)) return 'unknown';
  return holding.includes(true) ? 'ready' : 'none';
};

/**
 * The moves a conversation offers, by what it holds, not by where it is seen from: any copy in Trash
 * offers Restore, which also brings Archive's and Junk's back, so it replaces Move to inbox and Not
 * junk, as Move to inbox, which brings Junk's back too, replaces Not junk. All in Trash, that is all
 * it offers.
 */
export const movesOffered = (
  thread: {
    readonly folders: readonly Folder[];
    readonly foldersByMailbox: Readonly<Record<string, readonly Folder[]>>;
  },
  junkFolders: JunkFolders,
) => {
  const { folders } = thread;
  const canRestore = folders.includes('trash');
  const isFiled = folders.includes('archive') && !folders.includes('inbox');
  const canMoveToInbox = isFiled && !canRestore;
  return {
    canRestore,
    canArchive: folders.includes('inbox'),
    canMoveToInbox,
    canMoveToJunk: junkReadiness(thread, junkFolders) === 'ready',
    canMoveOutOfJunk: folders.includes('junk') && !canRestore && !canMoveToInbox,
    canDelete: canMoveTo(folders, 'trash'),
  };
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
  readonly mailbox: string;
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
  readonly foldersByMailbox: Readonly<Record<string, readonly Folder[]>>;
};

const applyChange = <T extends Reconcilable>(thread: T, op: PendingOp): T => {
  if (op.change.kind === 'flag') {
    return { ...thread, [op.change.key]: op.change.value };
  }
  const held = thread.foldersByMailbox[op.mailbox];
  // A sync can leave the mailbox holding no copy any more; moving nothing must not invent one.
  if (held === undefined) return thread;
  const foldersByMailbox = {
    ...thread.foldersByMailbox,
    [op.mailbox]: foldersAfterMove(held, op.change.to),
  };
  // A move reaches only its own mailbox's copies; the thread is wherever any mailbox holds one.
  const folders = FOLDERS.filter(folder =>
    Object.values(foldersByMailbox).some(mailboxFolders => mailboxFolders.includes(folder)),
  );
  return { ...thread, folders, foldersByMailbox };
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

/** What is left after a sync of `mailbox` that started as sync number `completedSeq` has landed. */
export const retireOps = (
  ops: readonly PendingOp[],
  mailbox: string,
  completedSeq: number,
): readonly PendingOp[] =>
  ops.filter(
    op =>
      op.mailbox !== mailbox || op.retireAtSyncSeq === null || op.retireAtSyncSeq > completedSeq,
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
  throw new Error(renumberedText(folder));
};

/**
 * One mailbox's copies as the writes address them: one target per folder, off its sync mark.
 * Throws when a folder has not synced or was renumbered since the copies were read.
 */
export const flagTargets = (
  locations: readonly Omit<Location, 'mailbox'>[],
  marks: ReadonlyMap<Folder, FolderSync | null>,
): readonly FlagTarget[] =>
  [...Map.groupBy(locations, location => location.folder)].map(([folder, copies]) => {
    const mark = marks.get(folder);
    if (mark == null) throw new Error(`${folder} has not synced`);
    assertSameUidValidity(folder, mark.uidValidity, copies);
    return {
      folder,
      folderName: mark.name,
      uidValidity: mark.uidValidity,
      uids: copies.map(({ uid }) => uid),
    };
  });
