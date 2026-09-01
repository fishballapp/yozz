/**
 * The one IndexedDB database on this device: per-user rows (`revision-marks`, `unlock-keys`),
 * per-host rows (`tls-pins`, `tls-sessions`), and the derived mail cache per user, account and
 * folder. One database so one version number covers the schema.
 */
export class DeviceDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceDbError';
  }
}

const DB_NAME = 'yozz-device-state';
const DB_VERSION = 5;

type StoreSpec = { readonly name: string; readonly keyPath: string | string[] };

export const STORES = {
  marks: { name: 'revision-marks', keyPath: ['userId', 'recordId'] },
  unlockKeys: { name: 'unlock-keys', keyPath: 'userId' },
  tlsPins: { name: 'tls-pins', keyPath: 'peer' },
  tlsSessions: { name: 'tls-sessions', keyPath: 'peer' },
  mailSync: { name: 'mail-sync', keyPath: ['userId', 'account', 'folder'] },
  mailSummaries: { name: 'mail-summaries', keyPath: ['userId', 'account', 'folder', 'uid'] },
  mailBodies: { name: 'mail-bodies', keyPath: ['userId', 'account', 'folder', 'uid'] },
} as const satisfies Record<string, StoreSpec>;

/** Stores whose key path changed in a version: dropped and recreated on upgrade. Only the derived cache has ever changed shape. */
const REKEYED: readonly { readonly since: number; readonly names: readonly string[] }[] = [
  { since: 5, names: [STORES.mailSync.name, STORES.mailSummaries.name, STORES.mailBodies.name] },
];

type StoreName = (typeof STORES)[keyof typeof STORES]['name'];

export const getIdbFactory = (customFactory?: IDBFactory): IDBFactory => {
  const factory = customFactory ?? globalThis.indexedDB;
  if (!factory) {
    throw new DeviceDbError('IndexedDB is not available in this environment');
  }
  return factory;
};

export const openDeviceDb = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = (() => {
      try {
        return factory.open(DB_NAME, DB_VERSION);
      } catch (err) {
        throw new DeviceDbError(`Failed to open IndexedDB: ${String(err)}`);
      }
    })();

    req.onupgradeneeded = event => {
      for (const { since, names } of REKEYED) {
        if (event.oldVersion >= since) continue;
        for (const name of names) {
          if (req.result.objectStoreNames.contains(name)) req.result.deleteObjectStore(name);
        }
      }
      for (const { name, keyPath } of Object.values<StoreSpec>(STORES)) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name, { keyPath });
        }
      }
    };
    req.onsuccess = () => {
      // A newer tab's upgrade blocks until this connection closes; revision marks hold one open all session.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(new DeviceDbError(`IndexedDB open failed: ${String(req.error)}`));
    req.onblocked = () =>
      reject(new DeviceDbError('IndexedDB open blocked by existing connection'));
  });

/** Settled on the transaction, never on a request inside it: a request that succeeded in an aborted transaction touched nothing. */
/** One read-write transaction over several stores, for a clear that must be all-or-nothing. */
export const runStoresTransaction = (
  db: IDBDatabase,
  storeNames: readonly StoreName[],
  body: (tx: IDBTransaction) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = (() => {
      try {
        return db.transaction(storeNames as string[], 'readwrite');
      } catch (err) {
        throw new DeviceDbError(`Transaction start failed: ${String(err)}`);
      }
    })();
    body(tx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new DeviceDbError(`Transaction failed: ${String(tx.error)}`));
    tx.onabort = () => reject(new DeviceDbError(`Transaction aborted: ${String(tx.error)}`));
  });

export const runTransaction = <T>(
  db: IDBDatabase,
  storeName: StoreName,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = (() => {
      try {
        return db.transaction(storeName, mode);
      } catch (err) {
        throw new DeviceDbError(`Transaction start failed: ${String(err)}`);
      }
    })();
    // The value exists before the transaction commits and may only be handed out after.
    let result: T | undefined;
    body(tx.objectStore(storeName), value => {
      result = value;
    });
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(new DeviceDbError(`Transaction failed: ${String(tx.error)}`));
    tx.onabort = () => reject(new DeviceDbError(`Transaction aborted: ${String(tx.error)}`));
  });
