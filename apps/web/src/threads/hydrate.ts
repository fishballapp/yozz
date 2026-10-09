import { type Previews, previewKey } from './body-state';
import type { MailCache } from './cache';
import type { FolderSummaries } from './summaries';
import { FOLDERS } from './thread';

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
