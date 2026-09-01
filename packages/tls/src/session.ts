import { asciiLower, type PeerName } from '@yozz.app/x509';
import { binderListLength } from './handshake-messages.ts';
import {
  CIPHER_SUITES,
  type CipherSuite,
  deriveSecret,
  earlySecret,
  finishedKey,
  hkdfExpandLabel,
  transcriptHash,
  verifyData,
} from './key-schedule.ts';
import { type SignatureScheme, SUPPORTED_SIGNATURE_SCHEMES } from './wire.ts';

/** Split the way `PathValidationRequest` wants it. */
export type PeerCertificateChain = {
  readonly leafDer: Uint8Array;
  readonly intermediateDer: readonly Uint8Array[];
};

export type TlsSession = {
  /** Offering a ticket to a different host would tell it where else we have been. */
  readonly serverName: string;
  /** The identity checked on the issuing connection; a resumed handshake has no certificate to check a name against. */
  readonly expectedPeerName: PeerName | null;
  /** The binder runs on this suite's hash; §4.3.11 allows resumption only within the same hash. */
  readonly suite: CipherSuite;
  /** Travels as the PSK identity. */
  readonly ticket: Uint8Array;
  /** §4.7.1's `PSK`, already expanded through the ticket's own nonce. */
  readonly preSharedKey: Uint8Array;
  /** §4.3.11.1's `ticket_age_add`, the server's random offset. */
  readonly ticketAgeAdd: number;
  /** A real `Date`; a persisted session must revive it. */
  readonly receivedAt: Date;
  readonly lifetimeSeconds: number;
  /**
   * When the peer's certificate was last verified, carried forward unchanged through every renewal:
   * RFC 9846 §4.7.1 asks for a limit on the total lifetime of renewed keying material. A real `Date`.
   */
  readonly authenticatedAt: Date;
  /** Carried forward through renewals. A name rather than a code point, so it survives the caller's store. */
  readonly peerSignatureScheme: SignatureScheme;
  /** Carried forward, so a resumed handshake can re-validate the chain against today's clock and anchors (`reverifyOnResume`). */
  readonly peerCertificateChain: PeerCertificateChain;
};

/** RFC 9846 §4.7.1: 7 days, applied on the way in rather than as an alert. */
const MAX_TICKET_LIFETIME_SECONDS = 604_800;

/** RFC 9846 §4.7.1's recommended limit on renewed keying material. v1 checks no revocation, so a week. */
const MAX_AUTHENTICATION_AGE_SECONDS = 604_800;

/** A ticket must ride back inside a uint16 extension block. Real tickets are a few hundred octets. */
const MAX_TICKET_BYTES = 16_384;

/** RFC 9846 §4.7.1's `PSK`, or `undefined` for a ticket that could never be used. */
export const sessionFromTicket = async ({
  serverName,
  expectedPeerName,
  suite,
  resumptionSecret,
  receivedAt,
  authenticatedAt,
  peerSignatureScheme,
  peerCertificateChain,
  ticket,
  ticketNonce,
  ticketAgeAdd,
  ticketLifetime,
}: {
  readonly serverName: string;
  readonly expectedPeerName: PeerName | null;
  readonly suite: CipherSuite;
  readonly resumptionSecret: Uint8Array;
  readonly receivedAt: Date;
  readonly authenticatedAt: Date;
  readonly peerSignatureScheme: SignatureScheme;
  readonly peerCertificateChain: PeerCertificateChain;
  readonly ticket: Uint8Array;
  readonly ticketNonce: Uint8Array;
  readonly ticketAgeAdd: number;
  readonly ticketLifetime: number;
}): Promise<TlsSession | undefined> => {
  // Refused here rather than at `isSessionOfferable`, so the caller stores nothing.
  if (
    ticketLifetime === 0 ||
    ticket.length > MAX_TICKET_BYTES ||
    !isWithinAuthenticationCeiling(authenticatedAt, receivedAt)
  ) {
    return undefined;
  }
  return {
    serverName,
    expectedPeerName,
    suite,
    ticket,
    ticketAgeAdd,
    receivedAt,
    authenticatedAt,
    peerSignatureScheme,
    peerCertificateChain,
    lifetimeSeconds: Math.min(ticketLifetime, MAX_TICKET_LIFETIME_SECONDS),
    preSharedKey: await hkdfExpandLabel(
      suite,
      resumptionSecret,
      'resumption',
      ticketNonce,
      CIPHER_SUITES[suite].hashLength,
    ),
  };
};

/** `| undefined`: a rehydrated value wearing a type. */
const isDerChain = (chain: PeerCertificateChain | undefined): boolean =>
  chain?.leafDer instanceof Uint8Array &&
  Array.isArray(chain.intermediateDer) &&
  chain.intermediateDer.every(der => der instanceof Uint8Array);

/**
 * A revived session's type is a claim: JSON turns a scheme into an arbitrary string and a byte
 * array into an object. Called from `startTls` before a byte goes out; throws because a broken
 * store is the caller's bug, not the peer's.
 */
export const assertUsableSession = (session: TlsSession): void => {
  if (!SUPPORTED_SIGNATURE_SCHEMES.includes(session.peerSignatureScheme)) {
    throw new Error('the stored session names no signature scheme this client implements');
  }
  if (!isDerChain(session.peerCertificateChain)) {
    throw new Error('the stored session carries no usable peer certificate chain');
  }
};

export type PeerAuthentication = {
  readonly authenticatedAt: Date;
  readonly peerSignatureScheme: SignatureScheme;
  readonly peerCertificateChain: PeerCertificateChain;
};

/**
 * A resumed handshake verifies no signature, so a ticket it mints inherits the original
 * authentication. A fresh instant here would defeat `MAX_AUTHENTICATION_AGE_SECONDS` silently.
 */
export const inheritedAuthentication = (
  resumed: TlsSession | undefined,
  verifiedNow: PeerAuthentication | undefined,
): PeerAuthentication => {
  if (resumed !== undefined) {
    assertUsableSession(resumed);
    const { authenticatedAt, peerSignatureScheme, peerCertificateChain } = resumed;
    return { authenticatedAt, peerSignatureScheme, peerCertificateChain };
  }
  if (verifiedNow === undefined) {
    // Unreachable from the handshake, which completes without a CertificateVerify only when resuming.
    throw new Error('a connection authenticated the peer neither freshly nor by resumption');
  }
  return verifiedNow;
};

const isWithinAuthenticationCeiling = (authenticatedAt: Date, now: Date): boolean => {
  const age = now.getTime() - authenticatedAt.getTime();
  return age >= 0 && age < MAX_AUTHENTICATION_AGE_SECONDS * 1000;
};

const ticketAgeMs = (session: TlsSession, now: Date): number =>
  now.getTime() - session.receivedAt.getTime();

/** RFC 9846 §4.3.11.1: age in milliseconds plus the server's offset, modulo 2^32. */
export const obfuscatedTicketAge = (session: TlsSession, now: Date): number =>
  (ticketAgeMs(session, now) + session.ticketAgeAdd) % 0x1_0000_0000;

/** `asciiLower`, not `toLowerCase`: KELVIN SIGN folds to `k` under Unicode, which would widen a security check. */
const isSamePeerName = (a: PeerName | null, b: PeerName | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'dns' ? asciiLower(a.value) === asciiLower(b.value) : a.value === b.value;
};

/**
 * Identity first: a resumed handshake proves nothing about the peer. Then two clocks, the
 * ticket's own age and the age of the certificate check behind it. A negative age would encode
 * as a huge `obfuscated_ticket_age`.
 */
export const isSessionOfferable = (
  session: TlsSession,
  serverName: string,
  expectedPeerName: PeerName | null,
  now: Date,
): boolean => {
  const age = ticketAgeMs(session, now);
  return (
    asciiLower(session.serverName) === asciiLower(serverName) &&
    isSamePeerName(session.expectedPeerName, expectedPeerName) &&
    age >= 0 &&
    age < session.lifetimeSeconds * 1000 &&
    isWithinAuthenticationCeiling(session.authenticatedAt, now)
  );
};

/**
 * RFC 9846 §4.3.11.2, over the transcript ending in a truncated ClientHello. After a
 * HelloRetryRequest that is three messages, hence the whole transcript rather than one.
 */
export const pskBinder = async (
  session: TlsSession,
  ...transcript: readonly Uint8Array[]
): Promise<Uint8Array> => {
  const binderKey = await deriveSecret(
    session.suite,
    await earlySecret(session.suite, session.preSharedKey),
    'res binder',
  );
  return verifyData(
    session.suite,
    await finishedKey(session.suite, binderKey),
    await transcriptHash(session.suite, ...transcript),
  );
};

/** The binder covers the message it travels in, so the bytes exist first with the binder zeroed. */
export const bindClientHello = async (
  session: TlsSession,
  clientHello: Uint8Array,
  precedingMessages: readonly Uint8Array[],
): Promise<Uint8Array<ArrayBuffer>> => {
  const binderLength = CIPHER_SUITES[session.suite].hashLength;
  const truncated = clientHello.subarray(0, clientHello.length - binderListLength(binderLength));
  const binder = await pskBinder(session, ...precedingMessages, truncated);
  const bound = new Uint8Array(clientHello);
  bound.set(binder, clientHello.length - binderLength);
  return bound;
};
