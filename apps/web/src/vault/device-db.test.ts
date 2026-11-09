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

  it('refetches every cached body after version 12, keeping the previews beside them', async () => {
    const idb = new IDBFactory();
    // A device at version 12 holding one body and its preview, as the cache wrote them.
    await new Promise<void>((resolve, reject) => {
      const req = idb.open('yozz-device-state', 12);
      req.onupgradeneeded = () => {
        for (const store of [STORES.mailBodies, STORES.mailPreviews]) {
          req.result.createObjectStore(store.name, { keyPath: [...store.keyPath] });
        }
      };
      req.onsuccess = () => {
        const tx = req.result.transaction(
          [STORES.mailBodies.name, STORES.mailPreviews.name],
          'readwrite',
        );
        const row = { userId: 'u', account: 'a', folder: 'inbox', uid: 1 };
        tx.objectStore(STORES.mailBodies.name).put({ ...row, body: {} });
        tx.objectStore(STORES.mailPreviews.name).put({ ...row, paragraphs: ['Hi.'] });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
      req.onerror = () => reject(req.error);
    });

    const db = await openDeviceDb(idb);
    const count = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const counts = [await count(STORES.mailBodies.name), await count(STORES.mailPreviews.name)];
    db.close();
    // A body written before `unsubscribe` was kept would read as offering nothing.
    expect(counts).toEqual([0, 1]);
  });
});
