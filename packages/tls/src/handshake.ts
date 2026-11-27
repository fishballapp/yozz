import type { PeerName, TrustAnchorSource, Validator } from '@yozz.app/x509';
import type { TlsFailure } from './alert.ts';
import { type ReplayClientHelloHooks, sendClientHello } from './handshake/client-hello.ts';
import {
  createTls12Connection,
  createTls13Connection,
  type TlsCloseResult,
  type TlsConnection,
  type TlsReadResult,
  type TlsWriteResult,
} from './handshake/connection.ts';
import { createHandshakePeer } from './handshake/peer.ts';
import { receiveServerHello } from './handshake/server-hello.ts';
import { completeTls12Flight } from './handshake/tls12-flight.ts';
import { completeTls13Flight } from './handshake/tls13-flight.ts';
import { assertUsableSession, type TlsSession } from './session.ts';
import { Transcript } from './transcript.ts';
import type { ByteDuplex } from './transport.ts';
import type {
  NamedGroup,
  SignatureScheme,
  Tls12SignatureScheme,
  TlsProtocolVersion,
} from './wire.ts';

export type { TlsCloseResult, TlsConnection, TlsReadResult, TlsWriteResult };

export type StartTlsOptions = {
  readonly transport: ByteDuplex;
  readonly serverName: string;
  readonly trustAnchors: TrustAnchorSource;
  readonly validationTime: Temporal.Instant;
  readonly validator: Validator;
  readonly expectedPeerName?: PeerName | null;
  /** Lowest TLS version accepted. Defaults to `'TLS 1.2'`. */
  readonly minVersion?: TlsProtocolVersion;
  /** Highest TLS version offered. Defaults to `'TLS 1.3'`. */
  readonly maxVersion?: TlsProtocolVersion;
  /** In preference order; the first carries the key share. */
  readonly supportedGroups?: readonly NamedGroup[];
  /**
   * In preference order. RFC 9846 §4.5.2: a TLS 1.3 CertificateVerify signed with a scheme not
   * offered here (or with RSA-PKCS1) is refused; under TLS 1.2, RSA-PKCS1 is accepted when offered.
   */
  readonly signatureSchemes?: readonly Tls12SignatureScheme[];
  /**
   * Offer each session once (RFC 9846 App. C.4: reuse lets observers correlate connections): the
   * caller evicts what it passed and keeps what `onSession` hands back. Refused unless `serverName`
   * and `expectedPeerName` match the issuing connection.
   */
  readonly session?: TlsSession;
  /**
   * Whether a resumed handshake re-validates the stored chain against today's clock and anchors.
   * Default `true`. Failure is `{ kind: 'certificate', chain: 'session-stored' }`: evict the
   * session and reconnect.
   */
  readonly reverifyOnResume?: boolean;
  /** Tickets arrive after the handshake, so this fires from `read()`. Without it, tickets are dropped. */
  readonly onSession?: (session: TlsSession) => void | Promise<void>;
  /** The running clock for ticket ages, distinct from `validationTime` (a policy input a caller may freeze). Injectable for BoGo. */
  readonly now?: () => Temporal.Instant;
};

export type HandshakeResult<Tls12Scheme extends Tls12SignatureScheme = Tls12SignatureScheme> =
  | {
      readonly ok: true;
      readonly protocolVersion: 'TLS 1.3';
      readonly connection: TlsConnection;
      /** The group the key exchange actually ran on, which a HelloRetryRequest can change. */
      readonly negotiatedGroup: NamedGroup;
      /** Whether the server took the offered session, skipping its certificate. */
      readonly isResumed: boolean;
      /** Whether the server asked for a second ClientHello before answering. */
      readonly isHelloRetryRequested: boolean;
      /** On a resumption, restored from the session. */
      readonly peerSignatureScheme: SignatureScheme;
      /**
       * RFC 7469 pin of the key that authenticated this peer, from the validated path. Only a
       * completed handshake has one: earlier, the peer has only sent a public chain. `null` on a
       * resumption with `reverifyOnResume` off.
       */
      readonly peerPublicKeyPin: string | null;
    }
  | {
      readonly ok: true;
      readonly protocolVersion: 'TLS 1.2';
      readonly connection: TlsConnection;
      /** The ECDHE group selected in ServerKeyExchange. */
      readonly negotiatedGroup: NamedGroup;
      /** TLS 1.2 session resumption is not implemented. */
      readonly isResumed: false;
      /** HelloRetryRequest is TLS 1.3 only. */
      readonly isHelloRetryRequested: false;
      readonly peerSignatureScheme: Tls12Scheme;
      /** RFC 7627: whether the server negotiated `extended_master_secret`. */
      readonly hasExtendedMasterSecret: boolean;
      /** RFC 7469 pin of the key that authenticated this peer, from the validated path. */
      readonly peerPublicKeyPin: string;
    }
  | { readonly ok: false; readonly reason: TlsFailure };

export type InternalReplayHooks = ReplayClientHelloHooks;

/** Exported for `replay.ts` only, which `index.test.ts` enforces. */
export const runHandshake = async (
  options: StartTlsOptions,
  replay?: InternalReplayHooks,
): Promise<HandshakeResult> => {
  // `Date.now()`, not `Temporal.Now`: a Worker's `Temporal.Now` reads the epoch inside a Durable Object.
  const now = options.now ?? (() => Temporal.Instant.fromEpochMilliseconds(Date.now()));
  const expectedPeerName =
    options.expectedPeerName !== undefined
      ? options.expectedPeerName
      : ({ kind: 'dns', value: options.serverName } as const);

  // Before a byte goes out, and unconditionally: a session that did not survive the store is the caller's bug.
  if (options.session !== undefined) {
    assertUsableSession(options.session);
  }

  const peer = createHandshakePeer({
    transport: options.transport,
    validator: options.validator,
    trustAnchors: options.trustAnchors,
    validationTime: options.validationTime,
    expectedPeerName,
  });

  const initialTranscript = new Transcript();
  const sentHello = await sendClientHello({
    peer,
    transcript: initialTranscript,
    serverName: options.serverName,
    expectedPeerName,
    minVersion: options.minVersion,
    maxVersion: options.maxVersion,
    supportedGroups: options.supportedGroups,
    signatureSchemes: options.signatureSchemes,
    session: options.session,
    now,
    replay,
  });
  if (!sentHello.ok) return sentHello;

  const serverHello = await receiveServerHello({
    peer,
    initialTranscript,
    clientHello: sentHello.value,
    serverName: options.serverName,
    now,
    replay,
  });
  if (!serverHello.ok) return serverHello;

  if (serverHello.version === 'TLS 1.2') {
    const flight = await completeTls12Flight({
      peer,
      suite: serverHello.value.suite,
      clientRandom: sentHello.value.ch1Random,
      serverRandom: serverHello.value.serverRandom,
      hasExtendedMasterSecret: serverHello.value.hasExtendedMasterSecret,
      transcriptMessages: serverHello.value.transcriptMessages,
      offeredGroupCodes: sentHello.value.offeredGroupCodes,
      offeredSchemes: sentHello.value.offeredSchemes,
    });
    if (!flight.ok) return flight;

    const connection = createTls12Connection({
      peer,
      suite: flight.value.suite,
      hasExtendedMasterSecret: serverHello.value.hasExtendedMasterSecret,
      masterSecret: flight.value.masterSecret,
      clientRandom: flight.value.clientRandom,
      serverRandom: flight.value.serverRandom,
      keys: flight.value.keys,
      initialClientWriteSeq: flight.value.clientWriteSeq,
      initialServerReadSeq: flight.value.serverReadSeq,
    });

    return {
      ok: true,
      protocolVersion: 'TLS 1.2',
      connection,
      negotiatedGroup: flight.value.negotiatedGroup,
      isResumed: false,
      isHelloRetryRequested: false,
      peerSignatureScheme: flight.value.peerSignatureScheme,
      hasExtendedMasterSecret: serverHello.value.hasExtendedMasterSecret,
      peerPublicKeyPin: flight.value.peerPublicKeyPin,
    };
  }

  const flight = await completeTls13Flight({
    peer,
    transcript: serverHello.value.transcript,
    suite: serverHello.value.suite,
    sharedSecret: serverHello.value.sharedSecret,
    resumedSession: serverHello.value.resumedSession,
    offeredExtensionCodes: sentHello.value.offeredExtensionCodes,
    offeredSchemes: sentHello.value.offeredSchemes,
    reverifyOnResume: options.reverifyOnResume ?? true,
    now,
  });
  if (!flight.ok) return flight;

  const connection = await createTls13Connection({
    peer,
    suite: serverHello.value.suite,
    clientAppTrafficSecret: flight.value.clientAppTrafficSecret,
    serverAppTrafficSecret: flight.value.serverAppTrafficSecret,
    exporterMaster: flight.value.exporterMaster,
    resumptionSecret: flight.value.resumptionSecret,
    authenticatedAt: flight.value.authenticatedAt,
    peerSignatureScheme: flight.value.peerSignatureScheme,
    peerCertificateChain: flight.value.peerCertificateChain,
    serverName: options.serverName,
    expectedPeerName,
    onSession: options.onSession,
    now,
  });

  return {
    ok: true,
    protocolVersion: 'TLS 1.3',
    connection,
    negotiatedGroup: serverHello.value.negotiatedGroup,
    isResumed: serverHello.value.resumedSession !== undefined,
    isHelloRetryRequested: serverHello.value.isHelloRetryRequested,
    peerSignatureScheme: flight.value.peerSignatureScheme,
    peerPublicKeyPin: flight.value.peerPublicKeyPin,
  };
};

export function startTls(
  options: StartTlsOptions & { readonly signatureSchemes: readonly SignatureScheme[] },
): Promise<HandshakeResult<SignatureScheme>>;
export function startTls(
  options: StartTlsOptions & { readonly minVersion: 'TLS 1.3' },
): Promise<HandshakeResult<SignatureScheme>>;
export function startTls(options: StartTlsOptions): Promise<HandshakeResult>;
export function startTls(options: StartTlsOptions): Promise<HandshakeResult> {
  return runHandshake(options);
}
