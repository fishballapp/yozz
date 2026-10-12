import type { TlsSession } from '@yozz.app/tls';
import { getIdbFactory, openDeviceDb, runTransaction, STORES } from '../vault/device-db';

/**
 * The resumption session `@yozz.app/tls` leaves to its caller, keyed by `host:port` and per device.
 * `host:port` rather than `host`: a ticket is bound to the `serverName` that issued it, which is the
 * same on a server's IMAP and SMTP ports, and the port keeps one from being offered to the other.
 * IndexedDB structured-clones a session as it is, so nothing here revives anything.
 */

type StoredSession = { readonly peer: string; readonly session: TlsSession };

export const peerKey = (host: string, port: number): string => `${host}:${port}`;

const withSessions = async <T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (value: T) => void) => void,
  idbFactory?: IDBFactory,
): Promise<T> => {
  const db = await openDeviceDb(getIdbFactory(idbFactory));
  try {
    return await runTransaction<T>(db, STORES.tlsSessions.name, mode, body);
  } finally {
    db.close();
  }
};

/** Read and delete in one transaction: a session is offered exactly once (RFC 9846 App. C.4). */
export const takeSession = (peer: string, idbFactory?: IDBFactory): Promise<TlsSession | null> =>
  withSessions<TlsSession | null>(
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
  withSessions<void>(
    'readwrite',
    (store, done) => {
      store.put({ peer, session } satisfies StoredSession);
      done();
    },
    idbFactory,
  );
