import type { DraftHandle } from '../compose/draft-vault.ts';
import { type BodyEntry, type Previews, previewKey, withBodies } from './body-state.ts';
import type { MailCache } from './cache.ts';
import {
  type AccountSummaries,
  type FolderSummaries,
  threadsFromAccounts,
  type VaultSentMessage,
  withDrafts,
} from './summaries.ts';
import { FOLDERS, type ThreadState } from './thread.ts';

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
export const cachedPreviews = async (cache: MailCache, account: string): Promise<Previews> => {
  const folderEntries = await Promise.all(
    FOLDERS.map(async folder => {
      const folderCache = cache.folder(folder);
      const mark = await folderCache.getSync();
      if (mark === null) return [];
      const previews = await folderCache.listPreviews();
      return previews.map(
        ({ uid, paragraphs }) =>
          [
            previewKey({ account, folder, uidValidity: mark.uidValidity, uid }),
            paragraphs,
          ] as const,
      );
    }),
  );
  return Object.fromEntries(folderEntries.flat());
};

/**
 * The conversations a client shows: one grouping pass over every account, or a conversation two
 * addresses are copied on splits in two; then the bodies on hand, the client's own overlay (the web
 * app's pending writes) and the vault's drafts.
 */
export const threadList = ({
  byAccount,
  vaultSent = [],
  bodies = {},
  previews = {},
  overlay = threads => threads,
  drafts = [],
}: {
  readonly byAccount: AccountSummaries;
  readonly vaultSent?: readonly VaultSentMessage[];
  readonly bodies?: Readonly<Record<string, BodyEntry>>;
  readonly previews?: Previews;
  readonly overlay?: (threads: readonly ThreadState[]) => readonly ThreadState[];
  readonly drafts?: readonly DraftHandle[];
}): readonly ThreadState[] =>
  withDrafts(
    overlay(withBodies(threadsFromAccounts(byAccount, vaultSent), bodies, previews)),
    drafts,
  );
