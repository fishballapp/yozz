/**
 * The one IndexedDB database this device keeps. `revision-marks` (the rollback
 * defence) and `unlock-keys` (the persisted unlock) are per-user rows;
 * `tls-pins` and `tls-sessions` (`mail/peer-store.ts`) are per mail host,
 * because a host's key is a fact about the host; `mail-sync`, `mail-summaries`
 * and `mail-bodies` (`mail/cache.ts`) are the derived mail cache, per user,
 * account and folder. One database so one version number covers the schema.
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

/**
 * Stores whose key path changed in a version: an upgrade from before it drops and recreates them.
 * Only the derived mail cache has ever changed shape, and it is rebuilt from the server.
 */
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
      // A newer tab bumping DB_VERSION needs this connection to close, or its upgrade blocks and
      // that tab falls back to locked. Revision marks hold a connection open for the whole
      // session, so without this the first schema bump after they open would deadlock the fleet.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(new DeviceDbError(`IndexedDB open failed: ${String(req.error)}`));
    req.onblocked = () =>
      reject(new DeviceDbError('IndexedDB open blocked by existing connection'));
  });

/**
 * Run `body` against one store and settle on the TRANSACTION, never on a
 * request inside it. A request that succeeded inside a transaction that then
 * aborts has not touched committed state: a read resolved early is a value
 * this device cannot stand behind, and a write resolved early is a write it
 * never kept. `body` returns the value the transaction's completion will deliver.
 */
/**
 * One read-write transaction spanning several stores, settled on completion. For an invalidation
 * that must be all-or-nothing — clearing a user's whole mail cache is three stores, and a partial
 * clear can leave a body whose summary is gone.
 */
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
    // Flipped by the body's `done`, read by `oncomplete`: the value exists before
    // the transaction commits and may only be handed out after.
    let result: T | undefined;
    body(tx.objectStore(storeName), value => {
      result = value;
    });
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(new DeviceDbError(`Transaction failed: ${String(tx.error)}`));
    tx.onabort = () => reject(new DeviceDbError(`Transaction aborted: ${String(tx.error)}`));
  });
