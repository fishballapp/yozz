import { getIdbFactory, openDeviceDb, runTransaction, STORES } from './device-db.ts';

/**
 * What a reload needs to reopen the vault without asking again: the key that
 * wraps the DEK and the wrap itself. `encKey` is a non-extractable `CryptoKey`
 * and structured clone keeps it that way — after a reload JS can USE it, and
 * still cannot export it. An unlocked device stays unlocked until sign-out,
 * the same bar as webmail.
 */
export type UnlockKeys = {
  readonly userId: string;
  readonly mode: 'password' | 'passkey';
  readonly encKey: CryptoKey;
  readonly wrappedDek: string;
  /**
   * What the server said the vault was when these keys were saved (`vaultStamp`). A resume
   * compares it against the server again: a reset, a re-enrolment or a mode switch made
   * elsewhere changes the stamp, and a DEK that no longer matches the server must not write.
   */
  readonly stamp: string;
};

const withDb = async <T>(
  idbFactory: IDBFactory | undefined,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> => {
  const db = await openDeviceDb(getIdbFactory(idbFactory));
  try {
    return await runTransaction<T>(db, STORES.unlockKeys.name, mode, body);
  } finally {
    db.close();
  }
};

export const saveUnlockKeys = (
  { userId, mode, encKey, wrappedDek, stamp }: UnlockKeys,
  idbFactory?: IDBFactory,
): Promise<void> =>
  withDb<void>(idbFactory, 'readwrite', (store, done) => {
    // Picked field by field: a session carries closures, and structured clone rejects those.
    store.put({ userId, mode, encKey, wrappedDek, stamp } satisfies UnlockKeys);
    done();
  });

export const loadUnlockKeys = (
  userId: string,
  idbFactory?: IDBFactory,
): Promise<UnlockKeys | null> =>
  withDb<UnlockKeys | null>(idbFactory, 'readonly', (store, done) => {
    const req = store.get(userId);
    req.onsuccess = () => done((req.result as UnlockKeys | undefined) ?? null);
  });

export const forgetUnlockKeys = (userId: string, idbFactory?: IDBFactory): Promise<void> =>
  withDb<void>(idbFactory, 'readwrite', (store, done) => {
    store.delete(userId);
    done();
  });
