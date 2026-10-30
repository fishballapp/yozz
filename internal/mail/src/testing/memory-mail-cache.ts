import type { ImapMessageSummary } from '@yozz.app/imap';
import type { FetchedBody } from '../threads/bodies.ts';
import type { FolderCache, FolderSync, MailCache } from '../threads/cache.ts';
import type { Folder } from '../threads/thread.ts';

/** A `MailCache` in memory, for tests of what reads and writes one. */
export const memoryMailCache = (): MailCache => {
  const folders = new Map<Folder, FolderCache>();
  const folderCache = (): FolderCache => {
    let sync: FolderSync | null = null;
    const summaries = new Map<number, ImapMessageSummary>();
    const bodies = new Map<number, FetchedBody>();
    return {
      getSync: async () => sync,
      putSync: async next => {
        sync = next;
      },
      listSummaries: async () => [...summaries.values()],
      putSummaries: async next => {
        for (const summary of next) summaries.set(summary.uid, summary);
      },
      deleteSummaries: async uids => {
        for (const uid of uids) summaries.delete(uid);
      },
      updateSummaries: async (uids, update) => {
        for (const uid of uids) {
          const summary = summaries.get(uid);
          if (summary !== undefined) summaries.set(uid, update(summary));
        }
      },
      getBody: async uid => bodies.get(uid) ?? null,
      listBodyUids: async () => new Set(bodies.keys()),
      listPreviews: async () => [...bodies].map(([uid, { paragraphs }]) => ({ uid, paragraphs })),
      putBody: async (uid, body) => {
        bodies.set(uid, body);
      },
    };
  };
  return {
    folder: folder => {
      const existing = folders.get(folder);
      if (existing !== undefined) return existing;
      const created = folderCache();
      folders.set(folder, created);
      return created;
    },
    clear: async () => {
      folders.clear();
    },
  };
};
