import type { RevisionMarks } from '@yozz.app/vault';
import { DeviceDbError, getIdbFactory, openDeviceDb, runTransaction, STORES } from './device-db.ts';

type StoredMark = {
  readonly userId: string;
  readonly recordId: string;
  readonly revision: number;
};

export type PersistentRevisionMarks = RevisionMarks & {
  /**
   * Opens the database, or rejects. Unlock must await this so a denied or
   * unavailable IndexedDB blocks the unlock rather than surfacing later on a
   * read — the marks are the whole rollback defence, and a session that
   * "unlocked" without them is a session running with the defence off.
   */
  readonly open: () => Promise<void>;
  readonly close: () => void;
};

export const createIndexedDbRevisionMarks = (
  userId: string,
  idbFactory?: IDBFactory,
): PersistentRevisionMarks => {
  const factory = getIdbFactory(idbFactory);
  // A lazy handle and a closed flag: both are mutated by design.
  let dbPromise: Promise<IDBDatabase> | null = null;
  let isClosed = false;

  const getDb = (): Promise<IDBDatabase> => {
    if (isClosed) {
      throw new DeviceDbError('Revision marks database handle is closed');
    }
    dbPromise ??= openDeviceDb(factory);
    return dbPromise;
  };

  const highWaterMark = async (recordId: string): Promise<number | undefined> =>
    runTransaction<number | undefined>(
      await getDb(),
      STORES.marks.name,
      'readonly',
      (store, done) => {
        const req = store.get([userId, recordId]);
        req.onsuccess = () => done((req.result as StoredMark | undefined)?.revision);
      },
    );

  const raiseTo = async (recordId: string, revision: number): Promise<void> =>
    runTransaction<void>(await getDb(), STORES.marks.name, 'readwrite', (store, done) => {
      // Read-and-max inside ONE readwrite transaction, which IndexedDB
      // serialises against every other readwrite on this store.
      const req = store.get([userId, recordId]);
      req.onsuccess = () => {
        const current = (req.result as StoredMark | undefined)?.revision;
        if (current === undefined || revision > current) {
          store.put({ userId, recordId, revision } satisfies StoredMark);
        }
        done();
      };
    });

  return {
    open: async () => {
      await getDb();
    },
    highWaterMark,
    raiseTo,
    close: () => {
      isClosed = true;
      const pending = dbPromise;
      dbPromise = null;
      void (async () => {
        try {
          (await pending)?.close();
        } catch {
          // Never opened, so there is nothing to close.
        }
      })();
    },
  };
};
