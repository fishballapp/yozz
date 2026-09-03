import { z } from 'zod';
import type { MailConnectionFailure } from '../relay/connection';
import type { AccountSyncState } from './sync';
import { type Folder, isArchived, isTrashed, type Thread, type ThreadState } from './thread';

/**
 * Every destination the rail can point at. A mailbox id is a URL segment: views are a closed
 * set, an address is any email string, and an unconnected address is an in-pane state.
 */
const viewIdSchema = z.enum(['unified', 'starred', 'archive', 'sent', 'trash', 'drafts']);
type ViewId = z.infer<typeof viewIdSchema>;

export const isViewId = (value: string): value is ViewId => viewIdSchema.safeParse(value).success;

export const mailboxIdSchema = z.union([viewIdSchema, z.string().email()]);

export type MailboxId = z.infer<typeof mailboxIdSchema>;

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
const VIEW_SHOWS: Record<ViewId, (thread: ThreadState) => boolean> = {
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
const VIEW_PAGES: Record<ViewId, Folder> = {
  unified: 'inbox',
  starred: 'inbox',
  archive: 'archive',
  sent: 'sent',
  trash: 'trash',
  // Drafts are vault records, not a folder.
  drafts: 'drafts',
};

export const folderPaged = (mailbox: MailboxId): Folder => {
  const view = viewIdSchema.safeParse(mailbox);
  return view.success ? VIEW_PAGES[view.data] : 'inbox';
};

/** Every account for a view, the named one for an address. */
export const accountsShown = <T extends { readonly address: string }>(
  accounts: readonly T[],
  mailbox: MailboxId,
): readonly T[] =>
  isViewId(mailbox) ? accounts : accounts.filter(account => account.address === mailbox);

/** An account that never synced or failed answers no: the foot control is hidden, so nothing may imply more mail. */
export const olderAvailable = (
  syncStates: Readonly<Record<string, AccountSyncState>>,
  accounts: readonly { readonly address: string }[],
  mailbox: MailboxId,
): boolean => {
  const folder = folderPaged(mailbox);
  return accountsShown(accounts, mailbox).some(account => {
    const state = syncStates[account.address];
    return state?.status === 'synced' && !state.complete.includes(folder);
  });
};

/** Asked of the whole set on screen; asking the single-address question of `/m/unified` read "Nothing here yet" through the first sync. */
export const syncProgressIn = <T extends { readonly address: string }>(
  syncStates: Readonly<Record<string, AccountSyncState>>,
  accounts: readonly T[],
  mailbox: MailboxId,
): {
  readonly pending: readonly T[];
  readonly failed: readonly { readonly account: T; readonly failure: MailConnectionFailure }[];
} => {
  const shown = accountsShown(accounts, mailbox);
  return {
    // No state yet reads the same as mid-fetch to someone waiting.
    pending: shown.filter(account => {
      const status = syncStates[account.address]?.status;
      return status === undefined || status === 'idle' || status === 'syncing';
    }),
    failed: shown.flatMap(account => {
      const state = syncStates[account.address];
      return state?.status === 'failed' ? [{ account, failure: state.failure }] : [];
    }),
  };
};

/** Which threads a mailbox shows, newest first. */
export const threadsIn = (threads: readonly ThreadState[], mailbox: MailboxId) => {
  const view = viewIdSchema.safeParse(mailbox);
  const shows = view.success
    ? VIEW_SHOWS[view.data]
    : // An address's view is a predicate over that account's copies alone.
      (thread: ThreadState) => (thread.foldersByAccount[mailbox] ?? []).includes('inbox');
  return threads.filter(shows).toSorted((a, b) => latestOf(b).at - latestOf(a).at);
};

export const unreadCount = (threads: readonly ThreadState[], mailbox: MailboxId) =>
  threadsIn(threads, mailbox).filter(thread => thread.isUnread).length;

const matches = (haystack: string, query: string) =>
  haystack.toLowerCase().includes(query.toLowerCase());

/**
 * The mailbox narrowed by `?q=`. Search reads subject, sender and whole body, not the snippet
 * (drawn from the newest message and cut to display length). One function because the list and
 * the status line need the same answer.
 */
export const visibleThreads = (
  threads: readonly ThreadState[],
  mailbox: MailboxId,
  query: string | undefined,
) => {
  const trimmed = query?.trim() ?? '';
  const inMailbox = threadsIn(threads, mailbox);
  if (trimmed === '') return inMailbox;
  return inMailbox.filter(
    thread =>
      matches(thread.subject, trimmed) ||
      thread.messages.some(
        message =>
          matches(message.fromName, trimmed) ||
          matches(message.fromAddress, trimmed) ||
          matches(message.toAddress, trimmed) ||
          matches(message.body.join(' '), trimmed),
      ),
  );
};

/** The id stays `unified`; on screen this is the inbox (DECISIONS.md, "Inbox", not "Unified"). */
export const mailboxLabel = (mailbox: MailboxId) => (mailbox === 'unified' ? 'inbox' : mailbox);
