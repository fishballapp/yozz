import { z } from 'zod';
import type { MailConnectionFailure } from '../connection.ts';
import { threadMatches } from './match.ts';
import { type FolderWindow, type OlderFrontier, olderFrontier } from './paging.ts';
import { hasCriteria, isThreadInScope, parseQuery, resolveScope, viewOfFolders } from './query.ts';
import type { MailboxSyncState } from './sync.ts';
import {
  type Folder,
  isArchived,
  isJunk,
  isTrashed,
  type Thread,
  type ThreadState,
} from './thread.ts';

/**
 * A view id is a URL segment: a named view is one of a closed set, an address is any email string,
 * and an unconnected address is an in-pane state.
 */
const namedViewSchema = z.enum([
  'unified',
  'starred',
  'archive',
  'sent',
  'trash',
  'junk',
  'drafts',
]);
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
  starred: thread => thread.isStarred && !isTrashed(thread) && !isJunk(thread),
  archive: isArchived,
  // What you sent, wherever the conversation now sits.
  sent: thread => thread.folders.includes('sent') && !isTrashed(thread),
  trash: thread => thread.folders.includes('trash'),
  junk: isJunk,
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
  junk: 'junk',
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
export const hasOlderMail = (state: MailboxSyncState | undefined, folder: Folder): boolean =>
  state?.status === 'synced' && !state.complete.includes(folder);

export const olderAvailable = (
  syncStates: Readonly<Record<string, MailboxSyncState>>,
  mailboxes: readonly { readonly address: string }[],
  view: ViewId,
): boolean => {
  const folder = folderPaged(view);
  return mailboxesShown(mailboxes, view).some(mailbox =>
    hasOlderMail(syncStates[mailbox.address], folder),
  );
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
  return threads
    .filter(thread => thread.isFoundOnly !== true && shows(thread))
    .toSorted((a, b) => latestOf(b).at - latestOf(a).at);
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

/** The search box's text over a view. */
const QUERY_OF_NAMED_VIEW: Record<NamedView, string> = {
  unified: 'in:inbox',
  starred: 'is:starred',
  archive: 'in:archive',
  sent: 'in:sent',
  trash: 'in:trash',
  junk: 'in:junk',
  drafts: 'in:drafts',
};

export const queryOfView = (view: ViewId) => {
  const named = namedViewSchema.safeParse(view);
  return named.success ? QUERY_OF_NAMED_VIEW[named.data] : `in:inbox mailbox:${view}`;
};

/** Order, repeats and an address's case say nothing about what a query asks. */
const meaningOf = (text: string) => {
  const query = parseQuery(text);
  return JSON.stringify({
    ...query,
    in: [...new Set(query.in)].toSorted(),
    mailboxes: [...new Set(query.mailboxes.map(address => address.toLowerCase()))].toSorted(),
  });
};

/** The view a query is exactly the query of, or null. An empty one is no view's. */
export const viewOfQuery = (
  text: string,
  mailboxes: readonly { readonly address: string }[],
): ViewId | null => {
  if (text.trim() === '') return null;
  const asked = meaningOf(text);
  return (
    [...namedViewSchema.options, ...mailboxes.map(({ address }) => address)].find(
      view => meaningOf(queryOfView(view)) === asked,
    ) ?? null
  );
};

/** The view a URL shows, or null when its `?q=` is a search. */
export const viewShown = (
  view: ViewId,
  q: string | undefined,
  mailboxes: readonly { readonly address: string }[],
) => (q === undefined ? view : viewOfQuery(q, mailboxes));

/** What a list across folders can show: nothing at or below where the soonest-stopping one has reached. */
export const withinReach = (
  threads: readonly ThreadState[],
  frontier: Pick<OlderFrontier, 'reachedAt'> | null,
) =>
  frontier === null ? threads : threads.filter(thread => latestOf(thread).at > frontier.reachedAt);

export type Listing = {
  /** What the search box says the list holds. */
  readonly query: string;
  readonly threads: readonly ThreadState[];
  /** What the rows open under and which triage they offer. */
  readonly view: ViewId;
  /** The query is not a view's own, so no view is what's on screen. */
  readonly isSearch: boolean;
  /** Why the query has no answer at all, which an empty list would misreport as no such mail. */
  readonly error: string | null;
  /** The folder to read further back in for more rows: what is synced, or what a search has named. */
  readonly older: OlderFrontier | null;
};

/**
 * What the list holds for a URL. A query equal to a view's own is that view. Any other looks where
 * `resolveScope` says, whichever view it was typed over: through what this device holds and, by
 * `isHit`, what the servers answered. One that only says where lists the synced windows, as far as
 * they all reach.
 */
export const listingOf = <T extends { readonly address: string }>({
  threads,
  view,
  q,
  mailboxes,
  windows = [],
  isHit = () => false,
  matchFrontier = null,
  isAnswering = false,
}: {
  readonly threads: readonly ThreadState[];
  readonly view: ViewId;
  readonly q: string | undefined;
  readonly mailboxes: readonly T[];
  readonly windows?: readonly FolderWindow[];
  readonly isHit?: (thread: ThreadState) => boolean;
  /** Where the matches the servers named stop being read. */
  readonly matchFrontier?: OlderFrontier | null;
  /** The servers have not all answered, so a page of older matches would race them. */
  readonly isAnswering?: boolean;
}): Listing => {
  const shown = viewShown(view, q, mailboxes);
  if (shown !== null) {
    return {
      query: queryOfView(shown),
      threads: threadsIn(threads, shown),
      view: shown,
      isSearch: false,
      error: null,
      older: null,
    };
  }
  const query = q ?? '';
  const parsed = parseQuery(query);
  const scope = resolveScope(parsed, mailboxes);
  if (!scope.ok) {
    return {
      query,
      threads: [],
      view: 'unified',
      isSearch: true,
      error: scope.error.message,
      older: null,
    };
  }
  const { folders, mailboxes: scoped } = scope.value;
  const inScope = threads.filter(isThreadInScope(scope.value));
  const byNewest = (rows: readonly ThreadState[]) =>
    rows.toSorted((a, b) => latestOf(b).at - latestOf(a).at);
  const answer = { query, view: viewOfFolders(folders), isSearch: true, error: null };
  if (hasCriteria(parsed)) {
    const matches = threadMatches(parsed);
    return {
      ...answer,
      threads: byNewest(
        withinReach(
          inScope.filter(thread => matches(thread) || isHit(thread)),
          matchFrontier,
        ),
      ),
      older: isAnswering ? null : matchFrontier,
    };
  }
  const older = olderFrontier(
    windows.filter(
      ({ mailbox, folder }) =>
        folders.includes(folder) && scoped.some(({ address }) => address === mailbox),
    ),
  );
  return {
    ...answer,
    threads: byNewest(
      withinReach(
        inScope.filter(thread => thread.isFoundOnly !== true),
        older,
      ),
    ),
    older,
  };
};

/** Where the reader goes when `threadId` is filed out of `list`: the row below, else the row above. */
export const neighbourOf = (list: readonly ThreadState[], threadId: string) => {
  const index = list.findIndex(candidate => candidate.id === threadId);
  return index === -1 ? undefined : (list[index + 1] ?? list[index - 1]);
};
