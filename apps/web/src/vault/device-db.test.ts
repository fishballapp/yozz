import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openDeviceDb, STORES } from './device-db';

/** The database as a version-6 device left it, with the `tls-pins` store pinning used to fill. */
const openVersion6 = (idb: IDBFactory): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = idb.open('yozz-device-state', 6);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tls-pins', { keyPath: 'peer' });
      req.result.createObjectStore(STORES.tlsSessions.name, { keyPath: 'peer' });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });

describe('device db', () => {
  it('drops a store the schema no longer names, and keeps the ones it does', async () => {
    const idb = new IDBFactory();
    await openVersion6(idb);
    const db = await openDeviceDb(idb);
    const names = Array.from(db.objectStoreNames);
    db.close();
    expect(names).not.toContain('tls-pins');
    expect(names).toEqual(expect.arrayContaining(Object.values(STORES).map(({ name }) => name)));
  });
});
