import type { RevisionMarks } from '@yozz.app/vault';
import { DeviceDbError, getIdbFactory, openDeviceDb, runTransaction, STORES } from './device-db.ts';

type StoredMark = {
  readonly userId: string;
  readonly recordId: string;
  readonly revision: number;
};

export type PersistentRevisionMarks = RevisionMarks & {
  /** Rejects on a denied or unavailable IndexedDB; the marks are the whole rollback defence. */
  readonly open: () => Promise<void>;
  readonly close: () => void;
};

export const createIndexedDbRevisionMarks = (
  userId: string,
  idbFactory?: IDBFactory,
): PersistentRevisionMarks => {
  const factory = getIdbFactory(idbFactory);
  // A lazy handle and a closed flag.
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
      // Read-and-max inside one readwrite transaction, which IndexedDB serialises.
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
          // Never opened.
        }
      })();
    },
  };
};
