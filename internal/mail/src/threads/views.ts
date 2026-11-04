import { z } from 'zod';
import type { MailConnectionFailure } from '../connection.ts';
import { threadMatches } from './match.ts';
import { hasCriteria, parseQuery } from './query.ts';
import type { MailboxSyncState } from './sync.ts';
import { type Folder, isArchived, isTrashed, type Thread, type ThreadState } from './thread.ts';

/**
 * A view id is a URL segment: a named view is one of a closed set, an address is any email string,
 * and an unconnected address is an in-pane state.
 */
const namedViewSchema = z.enum(['unified', 'starred', 'archive', 'sent', 'trash', 'drafts']);
type NamedView = z.infer<typeof namedViewSchema>;

export const isNamedView = (value: string): value is NamedView =>
  namedViewSchema.safeParse(value).success;

export const viewIdSchema = z.union([namedViewSchema, z.string().email()]);

export type ViewId = z.infer<typeof viewIdSchema>;

/** The most recent message decides a thread's position and its list timestamp. */
export const latestOf = (thread: Thread) => {
  const latest = thread.messages.at(-1);
  if (latest === undefined) throw new Error(`Thread ${thread.id} has no messages`);
  return latest;
};

/** Derived from the body, never authored beside it (DECISIONS.md); the ellipsis only when something was removed. */
const SNIPPET = 240;

export const previewOf = (thread: Thread) => {
  const body = latestOf(thread).body.join(' ');
  return body.length <= SNIPPET ? body : `${body.slice(0, SNIPPET).trimEnd()}…`;
};

/** One question per view about a thread's `folders`; adding a view does not compile until it answers. */
const VIEW_SHOWS: Record<NamedView, (thread: ThreadState) => boolean> = {
  unified: thread => thread.folders.includes('inbox'),
  starred: thread => thread.isStarred && !isTrashed(thread),
  archive: isArchived,
  // What you sent, wherever the conversation now sits.
  sent: thread => thread.folders.includes('sent') && !isTrashed(thread),
  trash: thread => thread.folders.includes('trash'),
  // The vault's drafts, in whatever conversation each belongs to.
  drafts: thread => thread.folders.includes('drafts'),
};

/** Starred and an address are filters of the inbox, so paging either pages the inbox. */
const VIEW_PAGES: Record<NamedView, Folder> = {
  unified: 'inbox',
  starred: 'inbox',
  archive: 'archive',
  sent: 'sent',
  trash: 'trash',
  // Drafts are vault records, not a folder.
  drafts: 'drafts',
};

export const folderPaged = (view: ViewId): Folder => {
  const named = namedViewSchema.safeParse(view);
  return named.success ? VIEW_PAGES[named.data] : 'inbox';
};

/** Every mailbox for a view, the named one for an address. */
export const mailboxesShown = <T extends { readonly address: string }>(
  mailboxes: readonly T[],
  view: ViewId,
): readonly T[] =>
  isNamedView(view) ? mailboxes : mailboxes.filter(mailbox => mailbox.address === view);

/** A mailbox that never synced or failed answers no: the foot control is hidden, so nothing may imply more mail. */
export const olderAvailable = (
  syncStates: Readonly<Record<string, MailboxSyncState>>,
  mailboxes: readonly { readonly address: string }[],
  view: ViewId,
): boolean => {
  const folder = folderPaged(view);
  return mailboxesShown(mailboxes, view).some(mailbox => {
    const state = syncStates[mailbox.address];
    return state?.status === 'synced' && !state.complete.includes(folder);
  });
};

/** Asked of the whole set on screen; asking the single-address question of `/m/unified` read "Nothing here yet" through the first sync. */
export const syncProgressIn = <T extends { readonly address: string }>(
  syncStates: Readonly<Record<string, MailboxSyncState>>,
  mailboxes: readonly T[],
  view: ViewId,
): {
  readonly pending: readonly T[];
  readonly failed: readonly { readonly mailbox: T; readonly failure: MailConnectionFailure }[];
} => {
  const shown = mailboxesShown(mailboxes, view);
  return {
    // No state yet reads the same as mid-fetch to someone waiting.
    pending: shown.filter(mailbox => {
      const status = syncStates[mailbox.address]?.status;
      return status === undefined || status === 'idle' || status === 'syncing';
    }),
    failed: shown.flatMap(mailbox => {
      const state = syncStates[mailbox.address];
      return state?.status === 'failed' ? [{ mailbox, failure: state.failure }] : [];
    }),
  };
};

/** Which threads a view shows, newest first. */
export const threadsIn = (threads: readonly ThreadState[], view: ViewId) => {
  const named = namedViewSchema.safeParse(view);
  const shows = named.success
    ? VIEW_SHOWS[named.data]
    : // An address's view is a predicate over that mailbox's copies alone.
      (thread: ThreadState) => (thread.foldersByMailbox[view] ?? []).includes('inbox');
  return threads.filter(shows).toSorted((a, b) => latestOf(b).at - latestOf(a).at);
};

export const unreadCount = (threads: readonly ThreadState[], view: ViewId) =>
  threadsIn(threads, view).filter(thread => thread.isUnread).length;

/**
 * The rows a view shows that the query's criteria hold for. One function because the list and
 * the status line need the same answer. A view is its own scope here, so `in:` and `mailbox:` say
 * nothing.
 */
export const visibleThreads = (
  threads: readonly ThreadState[],
  view: ViewId,
  query: string | undefined,
) => {
  const parsed = parseQuery(query ?? '');
  const inView = threadsIn(threads, view);
  return hasCriteria(parsed) ? inView.filter(threadMatches(parsed)) : inView;
};

/** Where the reader goes when `threadId` is filed out of `list`: the row below, else the row above. */
export const neighbourOf = (list: readonly ThreadState[], threadId: string) => {
  const index = list.findIndex(candidate => candidate.id === threadId);
  return index === -1 ? undefined : (list[index + 1] ?? list[index - 1]);
};

/** The id stays `unified`; on screen this is the inbox (DECISIONS.md, "Inbox", not "Unified"). */
export const viewLabel = (view: ViewId) => (view === 'unified' ? 'inbox' : view);
