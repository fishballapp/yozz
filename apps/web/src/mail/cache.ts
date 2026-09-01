import type { ImapMessageSummary } from '@yozz.app/imap';
import type { Folder } from '../lib/thread';
import {
  getIdbFactory,
  openDeviceDb,
  runStoresTransaction,
  runTransaction,
  STORES,
} from '../vault/device-db.ts';
import type { FetchedBody } from './bodies';

/**
 * Per device, derived from IMAP, rebuilt whenever lost (ARCHITECTURE.md, "State placement").
 * Per vault user, account and folder; dropped whole on lock. `mail-sync` holds the folder's IMAP
 * name, `UIDVALIDITY`, highest uid and whether its start is cached.
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

type StoreName = (typeof STORES)[keyof typeof STORES]['name'];

const withDb = async <T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
  idbFactory?: IDBFactory,
): Promise<T> => {
  const db = await openDeviceDb(getIdbFactory(idbFactory));
  try {
    return await runTransaction<T>(db, storeName, mode, body);
  } finally {
    db.close();
  }
};

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

    putBody: (uid: number, body: FetchedBody) =>
      withDb<void>(
        STORES.mailBodies.name,
        'readwrite',
        (store, done) => {
          store.put({ ...scope, uid, body } satisfies BodyRow);
          done();
        },
        idbFactory,
      ),
  };
};

export type FolderCache = ReturnType<typeof createFolderCache>;

export const createMailCache = (userId: string, account: string, idbFactory?: IDBFactory) => ({
  folder: (folder: Folder): FolderCache =>
    createFolderCache({ userId, account, folder }, idbFactory),

  /** All three stores in one transaction, or a reused uid could resolve to a stale body. */
  clear: async () => {
    const db = await openDeviceDb(getIdbFactory(idbFactory));
    try {
      await runStoresTransaction(
        db,
        [STORES.mailSync.name, STORES.mailSummaries.name, STORES.mailBodies.name],
        tx => {
          for (const name of [
            STORES.mailSync.name,
            STORES.mailSummaries.name,
            STORES.mailBodies.name,
          ]) {
            tx.objectStore(name).delete(accountRange(userId, account));
          }
        },
      );
    } finally {
      db.close();
    }
  },
});

export type MailCache = ReturnType<typeof createMailCache>;

/** Everything this user has cached; one transaction. */
export const clearMailCache = async (userId: string, idbFactory?: IDBFactory): Promise<void> => {
  const range = IDBKeyRange.bound([userId], [userId, []]);
  const db = await openDeviceDb(getIdbFactory(idbFactory));
  try {
    await runStoresTransaction(
      db,
      [STORES.mailSync.name, STORES.mailSummaries.name, STORES.mailBodies.name],
      tx => {
        for (const name of [
          STORES.mailSync.name,
          STORES.mailSummaries.name,
          STORES.mailBodies.name,
        ]) {
          tx.objectStore(name).delete(range);
        }
      },
    );
  } finally {
    db.close();
  }
};
