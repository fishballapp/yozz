import {
  createImapClient,
  type ImapClient,
  type ImapFailure,
  type ImapUntagged,
} from '@yozz.app/imap';
import { createSmtpClient, type SmtpClient, type SmtpFailure } from '@yozz.app/smtp';
import {
  type ByteDuplex,
  pinnedValidator,
  startTls,
  type TlsConnection,
  type TlsFailure,
  type TlsSession,
} from '@yozz.app/tls';
import { type TrustAnchorSource, YOZZ_VALIDATOR } from '@yozz.app/x509';
import type { AddressRecord } from '../lib/addresses';
import { trustAnchors } from './anchors';
import { loadPin, peerKey, savePin, saveSession, takeSession } from './peer-store';
import { openRelayTransport, type RelayTransport } from './relay-transport';

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type MailConnectionFailure =
  | { readonly kind: 'relay'; readonly detail: string }
  /** Something threw outside the protocol layers. */
  | { readonly kind: 'error'; readonly detail: string }
  | { readonly kind: 'tls'; readonly detail: string }
  /** The host proved a key other than the one pinned; Settings → Server keys accepts it. */
  | { readonly kind: 'pin-mismatch'; readonly peer: string }
  | { readonly kind: 'imap'; readonly reason: ImapFailure }
  | { readonly kind: 'smtp'; readonly reason: SmtpFailure }
  | { readonly kind: 'auth'; readonly text: string };

export type MailConnection = {
  readonly client: ImapClient;
  readonly close: () => Promise<void>;
  /** `HandshakeResult.isResumed`. */
  readonly resumed: boolean;
};

export type SmtpConnection = {
  readonly client: SmtpClient;
  readonly close: () => Promise<void>;
};

export const describeTlsFailure = (failure: TlsFailure): string => {
  switch (failure.kind) {
    case 'alert-sent':
      return `we sent ${failure.alert.description}`;
    case 'alert-received':
      return `server sent ${failure.alert.description}`;
    case 'alert-received-unknown':
      return `server sent unknown alert ${failure.code}`;
    case 'truncated':
      return 'connection truncated';
    case 'certificate':
      return `certificate ${failure.reason.code} (${failure.alert.description}, chain=${failure.chain})`;
  }
};

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  const code = 'code' in error ? (error as { code: unknown }).code : undefined;
  return code === undefined ? error.name : String(code);
};

type Host = { readonly host: string; readonly port: number };

type TlsDuplex = {
  readonly duplex: ByteDuplex;
  /** close_notify, then the relay socket; tolerant of either already being down. */
  readonly close: () => Promise<void>;
  readonly resumed: boolean;
};

type Handshake = {
  readonly tlsConn: TlsConnection;
  readonly transport: RelayTransport;
  /** `HandshakeResult.peerPublicKeyPin`. */
  readonly provenPin: string | null;
  readonly resumed: boolean;
};

/**
 * Relay socket → TLS 1.3 in the browser → a ByteDuplex. The port is checked against the one
 * implicit-TLS port, since 143/587 are STARTTLS. Trust on first use lives here on top of chain
 * validation; a stored session is offered once.
 */
export const openTlsDuplex = async (
  { host, port }: Host,
  expectedPort: 993 | 465,
  protocol: string,
): Promise<Result<TlsDuplex, MailConnectionFailure>> => {
  if (port !== expectedPort) {
    return {
      ok: false,
      error: {
        kind: 'relay',
        detail: `Port ${port} is not the ${protocol} port (${expectedPort})`,
      },
    };
  }

  let anchors: TrustAnchorSource;
  try {
    anchors = await trustAnchors();
  } catch (error) {
    return {
      ok: false,
      error: { kind: 'tls', detail: `Trust anchor compilation failed: ${errorText(error)}` },
    };
  }

  const peer = peerKey(host, port);
  let pin: string | null;
  let session: TlsSession | null;
  try {
    pin = await loadPin(peer);
    // Unpinned means the key has to be proven by a full handshake; a resumption would report the
    // stored leaf's key.
    session = pin === null ? null : await takeSession(peer);
  } catch (error) {
    return { ok: false, error: { kind: 'error', detail: `Peer store: ${errorText(error)}` } };
  }
  const validator =
    pin === null ? YOZZ_VALIDATOR : pinnedValidator({ validator: YOZZ_VALIDATOR, pin });

  const handshake = async (
    offered: TlsSession | null,
  ): Promise<Result<Handshake, MailConnectionFailure>> => {
    let transport: RelayTransport;
    try {
      transport = await openRelayTransport(host, port);
    } catch (error) {
      return { ok: false, error: { kind: 'relay', detail: errorText(error) } };
    }

    let tlsResult: Awaited<ReturnType<typeof startTls>>;
    try {
      tlsResult = await startTls({
        transport,
        serverName: host,
        trustAnchors: anchors,
        validationTime: new Date(),
        validator,
        session: offered ?? undefined,
        onSession: next => saveSession(peer, next),
      });
    } catch (error) {
      transport.close();
      return { ok: false, error: { kind: 'tls', detail: errorText(error) } };
    }
    if (tlsResult.ok) {
      return {
        ok: true,
        value: {
          tlsConn: tlsResult.connection,
          transport,
          provenPin: tlsResult.peerPublicKeyPin,
          resumed: tlsResult.isResumed,
        },
      };
    }

    transport.close();
    const { reason } = tlsResult;
    if (reason.kind === 'certificate' && reason.chain === 'session-stored' && offered !== null) {
      // The stored chain no longer validates (the host rotated); one handshake without the session
      // is what `TlsFailure.chain` prescribes, not a fallback.
      return handshake(null);
    }
    if (
      reason.kind === 'certificate' &&
      reason.reason.code === 'rejected-by-policy' &&
      pin !== null
    ) {
      return { ok: false, error: { kind: 'pin-mismatch', peer } };
    }
    return { ok: false, error: { kind: 'tls', detail: describeTlsFailure(reason) } };
  };

  const result = await handshake(session);
  if (!result.ok) return result;
  const { tlsConn, transport, provenPin, resumed } = result.value;

  const close = async () => {
    await tlsConn.close().catch(() => {});
    try {
      transport.close();
    } catch {
      // already closed
    }
  };

  if (pin === null && provenPin !== null) {
    try {
      await savePin(peer, provenPin);
    } catch (error) {
      await close();
      return { ok: false, error: { kind: 'error', detail: `Peer store: ${errorText(error)}` } };
    }
  }

  const duplex: ByteDuplex = {
    read: async () => {
      const res = await tlsConn.read();
      if (!res.ok || res.kind === 'closed') return null;
      return res.bytes;
    },
    write: async bytes => {
      const res = await tlsConn.write(bytes);
      if (!res.ok) {
        throw new Error(`TLS write error: ${describeTlsFailure(res.reason)}`);
      }
    },
  };

  return { ok: true, value: { duplex, close, resumed } };
};

export const connectImap = async (
  imap: AddressRecord['imap'] & {},
  options?: { readonly onUntagged?: (response: ImapUntagged) => void },
): Promise<Result<MailConnection, MailConnectionFailure>> => {
  const tls = await openTlsDuplex(imap, 993, 'IMAPS');
  if (!tls.ok) return tls;
  const { duplex, close: closeTls, resumed } = tls.value;

  const client = createImapClient(duplex, { onUntagged: options?.onUntagged });

  const greetingRes = await client.greeting();
  if (!greetingRes.ok) {
    await closeTls();
    return { ok: false, error: { kind: 'imap', reason: greetingRes.reason } };
  }

  const authRes = await client.authenticate(imap.username, imap.password);
  if (!authRes.ok) {
    await client.logout().catch(() => {});
    await closeTls();
    if (authRes.reason.kind === 'no') {
      return { ok: false, error: { kind: 'auth', text: authRes.reason.text } };
    }
    return { ok: false, error: { kind: 'imap', reason: authRes.reason } };
  }

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    await client.logout().catch(() => {});
    await closeTls();
  };

  return { ok: true, value: { client, close, resumed } };
};

/** Open, banner, EHLO, authenticate. `close` QUITs first; a 5xx on AUTH is an `auth` failure. */
export const connectSmtp = async (
  smtp: AddressRecord['smtp'],
): Promise<Result<SmtpConnection, MailConnectionFailure>> => {
  const tls = await openTlsDuplex(smtp, 465, 'SMTPS');
  if (!tls.ok) return tls;
  const { duplex, close: closeTls } = tls.value;

  const client = createSmtpClient(duplex);
  const fail = async (reason: SmtpFailure): Promise<Result<never, MailConnectionFailure>> => {
    await closeTls();
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
      await closeTls();
      return { ok: false, error: { kind: 'auth', text: auth.reason.text } };
    }
    return fail(auth.reason);
  }

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    await client.quit().catch(() => {});
    await closeTls();
  };
  return { ok: true, value: { client, close } };
};
