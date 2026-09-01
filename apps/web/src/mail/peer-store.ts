import type { TlsSession } from '@yozz.app/tls';
import { getIdbFactory, openDeviceDb, runTransaction, STORES } from '../vault/device-db.ts';

/**
 * The pin and the resumption session `@yozz.app/tls` leaves to its caller, keyed by `host:port`
 * and per device (DECISIONS.md, "Pins and sessions are per device"). IndexedDB structured-clones
 * a session as it is, so nothing here revives anything.
 */

export type PinnedPeer = { readonly peer: string; readonly pin: string };
type StoredSession = { readonly peer: string; readonly session: TlsSession };

export const peerKey = (host: string, port: number): string => `${host}:${port}`;

const withDb = async <T>(
  storeName: (typeof STORES)[keyof typeof STORES]['name'],
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

export const loadPin = (peer: string, idbFactory?: IDBFactory): Promise<string | null> =>
  withDb<string | null>(
    STORES.tlsPins.name,
    'readonly',
    (store, done) => {
      const req = store.get(peer);
      req.onsuccess = () => done((req.result as PinnedPeer | undefined)?.pin ?? null);
    },
    idbFactory,
  );

export const savePin = (peer: string, pin: string, idbFactory?: IDBFactory): Promise<void> =>
  withDb<void>(
    STORES.tlsPins.name,
    'readwrite',
    (store, done) => {
      store.put({ peer, pin } satisfies PinnedPeer);
      done();
    },
    idbFactory,
  );

const deleteSession = (peer: string, idbFactory?: IDBFactory): Promise<void> =>
  withDb<void>(
    STORES.tlsSessions.name,
    'readwrite',
    (store, done) => {
      store.delete(peer);
      done();
    },
    idbFactory,
  );

/**
 * Forgetting is how a new key is accepted; nothing writes a pin the user typed. The session goes
 * with it, or a resumption would hand the forgotten key straight back as the new pin.
 */
export const forgetPin = async (peer: string, idbFactory?: IDBFactory): Promise<void> => {
  await withDb<void>(
    STORES.tlsPins.name,
    'readwrite',
    (store, done) => {
      store.delete(peer);
      done();
    },
    idbFactory,
  );
  await deleteSession(peer, idbFactory);
};

export const listPins = (idbFactory?: IDBFactory): Promise<readonly PinnedPeer[]> =>
  withDb<readonly PinnedPeer[]>(
    STORES.tlsPins.name,
    'readonly',
    (store, done) => {
      const req = store.getAll();
      req.onsuccess = () => done(req.result as PinnedPeer[]);
    },
    idbFactory,
  );

/** Read and delete in one transaction: a session is offered exactly once (RFC 9846 App. C.4). */
export const takeSession = (peer: string, idbFactory?: IDBFactory): Promise<TlsSession | null> =>
  withDb<TlsSession | null>(
    STORES.tlsSessions.name,
    'readwrite',
    (store, done) => {
      const req = store.get(peer);
      req.onsuccess = () => {
        const stored = req.result as StoredSession | undefined;
        if (stored !== undefined) store.delete(peer);
        done(stored?.session ?? null);
      };
    },
    idbFactory,
  );

/** The newest ticket wins. */
export const saveSession = (
  peer: string,
  session: TlsSession,
  idbFactory?: IDBFactory,
): Promise<void> =>
  withDb<void>(
    STORES.tlsSessions.name,
    'readwrite',
    (store, done) => {
      store.put({ peer, session } satisfies StoredSession);
      done();
    },
    idbFactory,
  );
