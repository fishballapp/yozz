import type { ImapMessageSummary } from '@yozz.app/imap';
import {
  getIdbFactory,
  openDeviceDb,
  runStoresTransaction,
  runTransaction,
  STORES,
} from '../vault/device-db';
import type { FetchedBody } from './bodies';
import type { Folder } from './thread';

/**
 * Per device, derived from IMAP, rebuilt whenever lost (ARCHITECTURE.md, "State placement"). Per
 * vault user, account and folder; dropped whole on lock.
 */

export type FolderSync = {
  /** The mailbox `SELECT` names. */
  readonly name: string;
  readonly uidValidity: number;
  readonly lastUid: number;
  /** The folder's oldest message is cached. A row written before this field existed has no start cached yet. */
  readonly complete: boolean;
};

type Scope = { readonly userId: string; readonly account: string; readonly folder: Folder };
type SyncRow = Scope & FolderSync;
type SummaryRow = Scope & { readonly uid: number; readonly summary: ImapMessageSummary };
type BodyRow = Scope & { readonly uid: number; readonly body: FetchedBody };
type PreviewRow = Scope & { readonly uid: number; readonly paragraphs: readonly string[] };

/** Every store the mail cache owns, cleared together. */
const MAIL_STORES = [
  STORES.mailSync.name,
  STORES.mailSummaries.name,
  STORES.mailBodies.name,
  STORES.mailPreviews.name,
] as const;

type StoreName = (typeof STORES)[keyof typeof STORES]['name'];

/**
 * One connection per factory, held for the tab's life like the revision marks' handle: a body open
 * or a sync touches the cache a dozen times. `openDeviceDb` closes it on `versionchange` (an
 * upgrade or deletion elsewhere), and the next call opens a fresh one.
 */
const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

const deviceDbOf = (idbFactory?: IDBFactory): Promise<IDBDatabase> => {
  const factory = getIdbFactory(idbFactory);
  const open = connections.get(factory);
  if (open !== undefined) return open;
  const forget = () => {
    if (connections.get(factory) === opening) connections.delete(factory);
  };
  const opening = (async () => {
    try {
      const db = await openDeviceDb(factory);
      db.addEventListener('versionchange', forget);
      // The browser closed it (site data cleared).
      db.addEventListener('close', forget);
      return db;
    } catch (err) {
      forget();
      throw err;
    }
  })();
  connections.set(factory, opening);
  return opening;
};

const withDb = async <T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
  idbFactory?: IDBFactory,
): Promise<T> => runTransaction<T>(await deviceDbOf(idbFactory), storeName, mode, body);

const folderRange = ({ userId, account, folder }: Scope) =>
  IDBKeyRange.bound(
    [userId, account, folder, 0],
    [userId, account, folder, Number.MAX_SAFE_INTEGER],
  );

/** Arrays sort after strings, so `[]` is the ceiling. */
const accountRange = (userId: string, account: string) =>
  IDBKeyRange.bound([userId, account], [userId, account, []]);

const createFolderCache = (scope: Scope, idbFactory?: IDBFactory) => {
  const { userId, account, folder } = scope;
  return {
    getSync: () =>
      withDb<FolderSync | null>(
        STORES.mailSync.name,
        'readonly',
        (store, done) => {
          const req = store.get([userId, account, folder]);
          req.onsuccess = () => {
            const row = req.result as SyncRow | undefined;
            done(
              row === undefined
                ? null
                : {
                    name: row.name,
                    uidValidity: row.uidValidity,
                    lastUid: row.lastUid,
                    // A row written before `complete` existed has not reached the folder's start.
                    complete: row.complete ?? false,
                  },
            );
          };
        },
        idbFactory,
      ),

    putSync: (sync: FolderSync) =>
      withDb<void>(
        STORES.mailSync.name,
        'readwrite',
        (store, done) => {
          store.put({ ...scope, ...sync } satisfies SyncRow);
          done();
        },
        idbFactory,
      ),

    listSummaries: () =>
      withDb<readonly ImapMessageSummary[]>(
        STORES.mailSummaries.name,
        'readonly',
        (store, done) => {
          const req = store.getAll(folderRange(scope));
          req.onsuccess = () => done((req.result as SummaryRow[]).map(row => row.summary));
        },
        idbFactory,
      ),

    putSummaries: (summaries: readonly ImapMessageSummary[]) =>
      withDb<void>(
        STORES.mailSummaries.name,
        'readwrite',
        (store, done) => {
          for (const summary of summaries) {
            store.put({ ...scope, uid: summary.uid, summary } satisfies SummaryRow);
          }
          done();
        },
        idbFactory,
      ),

    deleteSummaries: (uids: readonly number[]) =>
      withDb<void>(
        STORES.mailSummaries.name,
        'readwrite',
        (store, done) => {
          for (const uid of uids) store.delete([userId, account, folder, uid]);
          done();
        },
        idbFactory,
      ),

    getBody: (uid: number) =>
      withDb<FetchedBody | null>(
        STORES.mailBodies.name,
        'readonly',
        (store, done) => {
          const req = store.get([userId, account, folder, uid]);
          req.onsuccess = () => done((req.result as BodyRow | undefined)?.body ?? null);
        },
        idbFactory,
      ),

    /** The uids of every cached body in the folder, reading keys only. */
    listBodyUids: () =>
      withDb<ReadonlySet<number>>(
        STORES.mailBodies.name,
        'readonly',
        (store, done) => {
          const req = store.getAllKeys(folderRange(scope));
          req.onsuccess = () =>
            done(new Set((req.result as [string, string, Folder, number][]).map(key => key[3])));
        },
        idbFactory,
      ),

    /** The text of every cached body in the folder, without the bodies themselves. */
    listPreviews: () =>
      withDb<readonly { readonly uid: number; readonly paragraphs: readonly string[] }[]>(
        STORES.mailPreviews.name,
        'readonly',
        (store, done) => {
          const req = store.getAll(folderRange(scope));
          req.onsuccess = () =>
            done((req.result as PreviewRow[]).map(({ uid, paragraphs }) => ({ uid, paragraphs })));
        },
        idbFactory,
      ),

    /** The body and its preview row in one transaction, so neither exists without the other. */
    putBody: async (uid: number, body: FetchedBody) => {
      const db = await deviceDbOf(idbFactory);
      await runStoresTransaction(db, [STORES.mailBodies.name, STORES.mailPreviews.name], tx => {
        tx.objectStore(STORES.mailBodies.name).put({ ...scope, uid, body } satisfies BodyRow);
        tx.objectStore(STORES.mailPreviews.name).put({
          ...scope,
          uid,
          paragraphs: body.paragraphs,
        } satisfies PreviewRow);
      });
    },
  };
};

export type FolderCache = ReturnType<typeof createFolderCache>;

export const createMailCache = (userId: string, account: string, idbFactory?: IDBFactory) => ({
  folder: (folder: Folder): FolderCache =>
    createFolderCache({ userId, account, folder }, idbFactory),

  /** Every store in one transaction, or a reused uid could resolve to a stale body. */
  clear: async () => {
    const db = await deviceDbOf(idbFactory);
    await runStoresTransaction(db, MAIL_STORES, tx => {
      for (const name of MAIL_STORES) {
        tx.objectStore(name).delete(accountRange(userId, account));
      }
    });
  },
});

export type MailCache = ReturnType<typeof createMailCache>;

/** Everything this user has cached; one transaction. */
export const clearMailCache = async (userId: string, idbFactory?: IDBFactory): Promise<void> => {
  const range = IDBKeyRange.bound([userId], [userId, []]);
  const db = await deviceDbOf(idbFactory);
  await runStoresTransaction(db, MAIL_STORES, tx => {
    for (const name of MAIL_STORES) {
      tx.objectStore(name).delete(range);
    }
  });
};
