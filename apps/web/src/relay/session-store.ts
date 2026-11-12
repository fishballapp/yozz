import type { TlsSession } from '@yozz.app/tls';
import { getIdbFactory, openDeviceDb, runTransaction, STORES } from '../vault/device-db';

/**
 * The resumption session `@yozz.app/tls` leaves to its caller, keyed by `host:port` and per device.
 * `host:port` rather than `host`: a ticket is bound to the `serverName` that issued it, which is the
 * same on a server's IMAP and SMTP ports, and the port keeps one from being offered to the other.
 * IndexedDB structured-clones a `Date` but not a `Temporal.Instant`, so a session's two instants
 * are stored as `Date`s, the shape every build has written.
 */

type StoredSession = {
  readonly peer: string;
  readonly session: Omit<TlsSession, 'receivedAt' | 'authenticatedAt'> & {
    readonly receivedAt: Date;
    readonly authenticatedAt: Date;
  };
};

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
        if (stored === undefined) {
          done(null);
          return;
        }
        store.delete(peer);
        const { receivedAt, authenticatedAt } = stored.session;
        done({
          ...stored.session,
          receivedAt: Temporal.Instant.fromEpochMilliseconds(receivedAt.getTime()),
          authenticatedAt: Temporal.Instant.fromEpochMilliseconds(authenticatedAt.getTime()),
        });
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
      store.put({
        peer,
        session: {
          ...session,
          // biome-ignore lint/plugin/no-date: IndexedDB cannot store a Temporal value, and shipped builds stored Dates, so the row keeps that shape.
          receivedAt: new Date(session.receivedAt.epochMilliseconds),
          // biome-ignore lint/plugin/no-date: IndexedDB cannot store a Temporal value, and shipped builds stored Dates, so the row keeps that shape.
          authenticatedAt: new Date(session.authenticatedAt.epochMilliseconds),
        },
      } satisfies StoredSession);
      done();
    },
    idbFactory,
  );
