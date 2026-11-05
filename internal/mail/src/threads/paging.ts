import type { ImapMessageSummary } from '@yozz.app/imap';
import { type MailboxSummaries, parseInternalDate } from './summaries.ts';
import { FOLDERS, type Folder } from './thread.ts';

/** How many windows of older mail one page may load before it answers short. */
export const OLDER_WINDOWS_PER_PAGE = 3;

/** What one mailbox's folder has cached, and whether that reaches the folder's start. */
export type FolderWindow = {
  readonly mailbox: string;
  readonly folder: Folder;
  readonly summaries: readonly ImapMessageSummary[];
  readonly isComplete: boolean;
};

/** Where a list across folders stops being whole. */
export type OlderFrontier = {
  readonly mailbox: string;
  readonly folder: Folder;
  /** At or below this, the folder has not been read, so a row there could hide mail above it. */
  readonly reachedAt: number;
};

/**
 * The folder that stops short soonest of those holding older mail than the cache reaches, or null
 * when none does. By uid, not the oldest date: a window is counted in arrival order, and a message
 * moved in keeps its old date, which says nothing about what lies below the window. An incomplete
 * folder with nothing cached (all of it filed away) reaches nowhere: its mail is unread, so any row
 * could hide some above it.
 */
export const olderFrontier = (windows: readonly FolderWindow[]): OlderFrontier | null =>
  windows
    .filter(({ isComplete }) => !isComplete)
    .flatMap(({ mailbox, folder, summaries }) => {
      if (summaries.length === 0) return [{ mailbox, folder, reachedAt: Number.POSITIVE_INFINITY }];
      const [reachedAt] = summaries
        .toSorted((a, b) => a.uid - b.uid)
        .flatMap(({ internalDate }) => parseInternalDate(internalDate) ?? []);
      return reachedAt === undefined ? [] : [{ mailbox, folder, reachedAt }];
    })
    .toSorted((a, b) => b.reachedAt - a.reachedAt)[0] ?? null;

/**
 * What a client holds in memory, as windows. Not the server's Drafts: the drafts shown are the
 * vault's, and server drafts are not threaded, so that window would clip a list to mail nobody sees.
 */
export const windowsOf = (
  byMailbox: MailboxSummaries,
  isComplete: (mailbox: string, folder: Folder) => boolean,
): readonly FolderWindow[] =>
  Object.entries(byMailbox).flatMap(([mailbox, byFolder]) =>
    FOLDERS.filter(folder => folder !== 'drafts').flatMap(folder => {
      const read = byFolder[folder];
      return read === undefined
        ? []
        : [{ mailbox, folder, summaries: read.summaries, isComplete: isComplete(mailbox, folder) }];
    }),
  );
