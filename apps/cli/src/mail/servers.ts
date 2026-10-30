import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { createImapClient, type ImapClient, type ImapUntagged } from '@yozz.app/imap';
import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { createSmtpClient, type SmtpClient, type SmtpFailure } from '@yozz.app/smtp';
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';

// How the CLI reaches a mail server: a TLS socket the IMAP and SMTP clients run over. The socket is
// the edge tests replace, so the greeting and the sign-in below run under test as they do for real.
// `@yozz.app/imap` and `@yozz.app/smtp` are promises, so this edge is too.

type Host = AddressRecord['smtp'];

/** The `ByteDuplex` both clients read and write. */
export type ByteDuplex = {
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
};

export type MailSocket = {
  readonly duplex: ByteDuplex;
  /** How long it may go without a byte either way before it is dropped; 0 waits for ever. */
  readonly setQuietLimit: (ms: number) => void;
  /** Ends it now, whatever the server does: nothing of it holds the process open. */
  readonly destroy: () => void;
};

/** Work that waits this long with nothing crossing the connection has stalled. */
export const QUIET_LIMIT_MS = 60_000;

export class MailServers extends Context.Service<
  MailServers,
  {
    /** A TLS connection to `host`, its certificate validated. */
    readonly open: (host: Host) => Promise<Result<MailSocket, MailConnectionFailure>>;
  }
>()('@yozz.app/cli/MailServers') {
  /** `node:tls` with Node's own certificate validation: no relay, no YOZZ TLS stack on this path. */
  static readonly layerTls = Layer.succeed(MailServers, MailServers.of({ open: openTls }));
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A `TLSSocket` as a `ByteDuplex`: chunks queue until read, and every end of the socket reads as `null`. */
const socketDuplex = (socket: TLSSocket): ByteDuplex => {
  const chunks: Uint8Array[] = [];
  let isEnded = false;
  let waiter: ((chunk: Uint8Array | null) => void) | null = null;
  const deliver = (chunk: Uint8Array | null) => {
    const pending = waiter;
    waiter = null;
    pending?.(chunk);
  };
  socket.on('data', (data: Buffer) => {
    const chunk = new Uint8Array(data);
    if (waiter === null) {
      chunks.push(chunk);
    } else {
      deliver(chunk);
    }
  });
  for (const event of ['end', 'close', 'error'] as const) {
    socket.on(event, () => {
      isEnded = true;
      deliver(null);
    });
  }
  return {
    read: () =>
      new Promise(resolve => {
        const buffered = chunks.shift();
        if (buffered !== undefined) return resolve(buffered);
        if (isEnded) return resolve(null);
        waiter = resolve;
      }),
    write: bytes =>
      new Promise((resolve, reject) => {
        socket.write(bytes, error => (error == null ? resolve() : reject(error)));
      }),
  };
};

function openTls({ host, port }: Host): Promise<Result<MailSocket, MailConnectionFailure>> {
  return new Promise(resolve => {
    const socket = tlsConnect({ host, port, servername: host });
    socket.setTimeout(QUIET_LIMIT_MS, () => socket.destroy(new Error(`${host} stopped answering`)));
    socket.once('secureConnect', () =>
      resolve({
        ok: true,
        value: {
          duplex: socketDuplex(socket),
          setQuietLimit: ms => socket.setTimeout(ms),
          destroy: () => socket.destroy(),
        },
      }),
    );
    socket.once('error', error => {
      socket.destroy();
      resolve({ ok: false, error: { kind: 'tls', detail: errorText(error) } });
    });
  });
}

/** The implicit-TLS port only: 143 and 587 are STARTTLS, which this client does not speak. */
const wrongPort = (
  { port }: Host,
  expected: 993 | 465,
  protocol: string,
): Result<never, MailConnectionFailure> | null =>
  port === expected
    ? null
    : {
        ok: false,
        error: { kind: 'error', detail: `Port ${port} is not the ${protocol} port (${expected})` },
      };

export type ImapConnection = {
  readonly client: ImapClient;
  readonly setQuietLimit: (ms: number) => void;
  /** LOGOUT, then the socket. */
  readonly close: () => Promise<void>;
};

/** Opened, greeted and signed in; `onUntagged` hears every untagged response. */
export const connectImap = async (
  { open }: MailServers['Service'],
  imap: Host,
  { onUntagged }: { readonly onUntagged: (response: ImapUntagged) => void },
): Promise<Result<ImapConnection, MailConnectionFailure>> => {
  const refused = wrongPort(imap, 993, 'IMAPS');
  if (refused !== null) return refused;
  const opened = await open(imap);
  if (!opened.ok) return opened;
  const { duplex, setQuietLimit, destroy } = opened.value;
  const client = createImapClient(duplex, { onUntagged });

  const greeting = await client.greeting();
  if (!greeting.ok) {
    destroy();
    return { ok: false, error: { kind: 'imap', reason: greeting.reason } };
  }
  const auth = await client.authenticate(imap.username, imap.password);
  if (!auth.ok) {
    await client.logout().catch(() => {});
    destroy();
    return auth.reason.kind === 'no'
      ? { ok: false, error: { kind: 'auth', text: auth.reason.text } }
      : { ok: false, error: { kind: 'imap', reason: auth.reason } };
  }

  let isClosed = false;
  return {
    ok: true,
    value: {
      client,
      setQuietLimit,
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        await client.logout().catch(() => {});
        destroy();
      },
    },
  };
};

export type SmtpConnection = {
  readonly client: SmtpClient;
  /** QUIT, then the socket. */
  readonly close: () => Promise<void>;
};

/** Opened, greeted, EHLO'd and signed in. A 5xx to AUTH is an `auth` failure. */
export const connectSmtp = async (
  { open }: MailServers['Service'],
  smtp: Host,
): Promise<Result<SmtpConnection, MailConnectionFailure>> => {
  const refused = wrongPort(smtp, 465, 'SMTPS');
  if (refused !== null) return refused;
  const opened = await open(smtp);
  if (!opened.ok) return opened;
  const { duplex, destroy } = opened.value;
  const client = createSmtpClient(duplex);
  const fail = (reason: SmtpFailure): Result<never, MailConnectionFailure> => {
    destroy();
    return { ok: false, error: { kind: 'smtp', reason } };
  };

  const banner = await client.greeting();
  if (!banner.ok) return fail(banner.reason);
  // The name after EHLO is ours to choose; the app's host is honest and stable.
  const caps = await client.ehlo('yozz.app');
  if (!caps.ok) return fail(caps.reason);
  const auth = await client.authenticate(smtp.username, smtp.password);
  if (!auth.ok) {
    await client.quit().catch(() => {});
    if (auth.reason.kind === 'reply' && auth.reason.code >= 500) {
      destroy();
      return { ok: false, error: { kind: 'auth', text: auth.reason.text } };
    }
    return fail(auth.reason);
  }

  let isClosed = false;
  return {
    ok: true,
    value: {
      client,
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        await client.quit().catch(() => {});
        destroy();
      },
    },
  };
};
