import type { DraftHandle } from '../compose/draft-vault.ts';
import { type BodyEntry, type Previews, previewKey, withBodies } from './body-state.ts';
import type { MailCache } from './cache.ts';
import {
  type FolderSummaries,
  type MailboxSummaries,
  threadsFromMailboxes,
  type VaultSentMessage,
  withDrafts,
} from './summaries.ts';
import { FOLDERS, type Folder, type ThreadState } from './thread.ts';

/** The list before the first sync of this unlock lands. Read all folders in parallel. */
export const cachedSummaries = async (cache: MailCache): Promise<FolderSummaries> => {
  const entries = await Promise.all(
    FOLDERS.map(async folder => {
      const folderCache = cache.folder(folder);
      const [mark, summaries] = await Promise.all([
        folderCache.getSync(),
        folderCache.listSummaries(),
      ]);
      return [
        folder,
        {
          // No sync mark means nothing read yet; UIDVALIDITY stands in as 0.
          uidValidity: mark?.uidValidity ?? 0,
          summaries,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
};

/** Every cached body's text, keyed for `withBodies`, so rows show excerpts before the first open. */
export const cachedPreviews = async (cache: MailCache, mailbox: string): Promise<Previews> => {
  const folderEntries = await Promise.all(
    FOLDERS.map(async folder => {
      const folderCache = cache.folder(folder);
      const mark = await folderCache.getSync();
      if (mark === null) return [];
      const previews = await folderCache.listPreviews();
      return previews.map(
        ({ uid, paragraphs }) =>
          [
            previewKey({ mailbox, folder, uidValidity: mark.uidValidity, uid }),
            paragraphs,
          ] as const,
      );
    }),
  );
  return Object.fromEntries(folderEntries.flat());
};

/** The cached summaries with `extra`'s laid over them by uid, in folders read under the same UIDVALIDITY. */
export const withExtra = (cached: FolderSummaries, extra: FolderSummaries): FolderSummaries =>
  Object.fromEntries(
    FOLDERS.flatMap(folder => {
      const read = cached[folder];
      const added = extra[folder];
      if (read === undefined) return added === undefined ? [] : [[folder, added]];
      if (added === undefined || added.uidValidity !== read.uidValidity) return [[folder, read]];
      const byUid = new Map(
        [...read.summaries, ...added.summaries].map(summary => [summary.uid, summary]),
      );
      return [[folder, { ...read, summaries: [...byUid.values()] }]];
    }),
  );

const copyKey = (mailbox: string, folder: Folder, uid: number) => `${mailbox}/${folder}/${uid}`;

/** A conversation no copy of which is in the windows the syncs keep: only a search knows it. */
const markFoundOnly = (
  threads: readonly ThreadState[],
  byMailbox: MailboxSummaries,
  found: MailboxSummaries,
): readonly ThreadState[] => {
  const foundOnly = new Set(
    Object.entries(found).flatMap(([mailbox, byFolder]) =>
      FOLDERS.flatMap(folder => {
        const held = new Set(byMailbox[mailbox]?.[folder]?.summaries.map(({ uid }) => uid));
        return (byFolder[folder]?.summaries ?? [])
          .filter(({ uid }) => !held.has(uid))
          .map(({ uid }) => copyKey(mailbox, folder, uid));
      }),
    ),
  );
  if (foundOnly.size === 0) return threads;
  return threads.map(thread =>
    thread.messages.every(
      ({ locations = [] }) =>
        locations.length > 0 &&
        locations.every(({ mailbox, folder, uid }) => foundOnly.has(copyKey(mailbox, folder, uid))),
    )
      ? { ...thread, isFoundOnly: true }
      : thread,
  );
};

/**
 * The conversations a client shows: one grouping pass over every mailbox, or a conversation two
 * addresses are copied on splits in two; then the bodies on hand, the client's own overlay (the web
 * app's pending writes) and the vault's drafts. `found` is what searches read beyond those windows,
 * threaded in and marked, never stored.
 */
export const threadList = ({
  byMailbox,
  found = {},
  vaultSent = [],
  bodies = {},
  previews = {},
  overlay = threads => threads,
  drafts = [],
}: {
  readonly byMailbox: MailboxSummaries;
  readonly found?: MailboxSummaries;
  readonly vaultSent?: readonly VaultSentMessage[];
  readonly bodies?: Readonly<Record<string, BodyEntry>>;
  readonly previews?: Previews;
  readonly overlay?: (threads: readonly ThreadState[]) => readonly ThreadState[];
  readonly drafts?: readonly DraftHandle[];
}): readonly ThreadState[] => {
  const merged = Object.fromEntries(
    [...new Set([...Object.keys(byMailbox), ...Object.keys(found)])].map(mailbox => [
      mailbox,
      withExtra(byMailbox[mailbox] ?? {}, found[mailbox] ?? {}),
    ]),
  );
  return markFoundOnly(
    withDrafts(
      overlay(withBodies(threadsFromMailboxes(merged, vaultSent), bodies, previews)),
      drafts,
    ),
    byMailbox,
    found,
  );
};
