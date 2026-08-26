/**
 * Session resumption — RFC 9846 §2.2, §4.3.11 and §4.7.1.
 *
 * A `NewSessionTicket` is not a session. It NAMES one: the secret it stands for
 * is derived from the connection that issued it, and the ticket itself is an
 * opaque label the server chose. So this module turns a ticket plus the
 * issuing connection's resumption master secret into a value a caller can
 * store, and computes the binder that proves, on the next connection, that we
 * hold the secret rather than merely the label.
 *
 * Nothing here reads or writes a record, and nothing here decides when to
 * resume — the handshake supplies the transcript and asks. That is what lets
 * every rule about whether a ticket is usable live here, stated once, rather
 * than at each of the sites that would otherwise have to remember them: two
 * that decide a ticket is not a session at all, and four that decide a stored
 * one may not go on the wire today.
 */

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

/**
 * The certificates the peer actually sent, split the way
 * `PathValidationRequest` wants them — so re-validating a stored chain is the
 * same call over the same shape, not a reassembly that could put the leaf in
 * the wrong slot.
 *
 * A leaf is not optional and the two halves are separate fields, which is what
 * makes "the chain is empty" unrepresentable rather than a case to check.
 */
export type PeerCertificateChain = {
  readonly leafDer: Uint8Array;
  readonly intermediateDer: readonly Uint8Array[];
};

export type TlsSession = {
  /**
   * The host this ticket came from. A ticket is an identifier the server hands
   * out in the clear and sees again in the clear, so offering one to a
   * different host tells that host where else we have been.
   */
  readonly serverName: string;
  /**
   * The identity the certificate was actually checked against on the connection
   * that issued this ticket — which is NOT always `serverName`, because
   * `expectedPeerName` may override it and `null` disables name matching
   * altogether.
   *
   * It travels with the session because a resumed handshake sends no
   * Certificate and no CertificateVerify: there is nothing left to check the
   * name against, so the only moment the identity can be established is the
   * connection that issued the ticket. Without this a session minted under
   * `null` could be offered on a connection that asked for a strict name, and
   * the strict check would never run.
   */
  readonly expectedPeerName: PeerName | null;
  /**
   * The suite that issued it, and with it the hash the binder runs on. A
   * server may resume at a different suite, but only one with the same hash
   * (§4.3.11), which is why this travels with the session rather than being
   * re-derived from whatever gets negotiated next.
   */
  readonly suite: CipherSuite;
  /** The opaque ticket, which travels as the PSK identity. */
  readonly ticket: Uint8Array;
  /** §4.7.1's `PSK`, already expanded through the ticket's own nonce. */
  readonly preSharedKey: Uint8Array;
  /** §4.3.11.1's `ticket_age_add`, the server's random offset. */
  readonly ticketAgeAdd: number;
  readonly receivedAt: Date;
  readonly lifetimeSeconds: number;
  /**
   * When the peer's certificate was last actually verified — carried FORWARD
   * unchanged through every renewal, so it dates the chain of tickets rather
   * than the newest one.
   *
   * RFC 9846 §4.7.1: "it is possible to continue issuing new tickets which
   * indefinitely extend the lifetime of the keying material originally derived
   * from an initial non-PSK handshake (which was most likely tied to the peer's
   * certificate). It is RECOMMENDED that implementations place limits on the
   * total lifetime of such keying material". Without this field there is nothing
   * to place a limit against: a resumed connection mints its own tickets, each
   * looking brand new, and the one signature that ever proved the peer's
   * identity recedes indefinitely into the past.
   */
  readonly authenticatedAt: Date;
  /**
   * The scheme the peer's CertificateVerify was signed with on the connection
   * that authenticated it — carried forward through every renewal, alongside
   * `authenticatedAt`, because they describe the same signature. The renewal
   * step used to be asserted by no test anywhere; `session.test.ts` now drives
   * RFC 8448 §4 through the state machine and seals a ticket under §4's own
   * published server application key to watch all three arrive.
   *
   * A resumed handshake sends no CertificateVerify, so without this a caller
   * asking "how was this peer authenticated" gets an answer on the first
   * connection and nothing on every one after it.
   *
   * A NAME rather than a code point, because this is the field that goes into
   * the caller's store: `'rsa_pss_rsae_sha512'` survives a rehydration and a
   * table edit where `2054` reads as nothing at all.
   */
  readonly peerSignatureScheme: SignatureScheme;
  /**
   * The chain the peer sent on the connection that authenticated it — carried
   * forward through every renewal beside `authenticatedAt` and
   * `peerSignatureScheme`, because all three describe that one authentication.
   *
   * It is here so a resumed handshake can validate the peer's chain AGAIN, as
   * of today's clock and today's trust anchors (`reverifyOnResume` in
   * `handshake.ts`). Nothing on a resumed wire carries a certificate, so the
   * stored copy is the only chain there is to check — and checking it is what
   * turns an expired leaf or a root we stopped shipping into a refusal on the
   * next reconnect rather than one up to `MAX_AUTHENTICATION_AGE_SECONDS`
   * later.
   *
   * It costs the caller's store a few KB per session, which is the whole price
   * of the check.
   */
  readonly peerCertificateChain: PeerCertificateChain;
};

/**
 * **Both `Date` fields are real `Date`s, and a caller that persists a session
 * has to revive them.** JSON turns them into strings, and this module reads them
 * with `.getTime()` — a rehydrated string would throw out of `startTls` rather
 * than being refused. The store is the caller's, so the revival is too.
 */

/**
 * RFC 9846 §4.7.1: "Servers MUST NOT use any value greater than 604800 seconds
 * (7 days)", and "Clients MUST NOT use tickets for longer than 7 days after
 * issuance, regardless of the ticket_lifetime". A server that sends more has not
 * earned a fatal alert — the RFC names none — so the ceiling is applied on the
 * way in and the session is simply shorter-lived than the server hoped.
 */
const MAX_TICKET_LIFETIME_SECONDS = 604_800;

/**
 * How long a chain of tickets may outlive the handshake that authenticated it.
 *
 * RFC 9846 §4.7.1 asks for a limit and says what it should weigh: "the lifetime
 * of the peer's certificate, the likelihood of intervening revocation, and the
 * time since the peer's online CertificateVerify signature". Two of those three
 * are sharp here — v1 checks no revocation at all, so a compromised key is only
 * ever noticed by a chain being rebuilt, and public mail leaves rotate every
 * 60-90 days. So the ceiling is the same week a single ticket gets: resumption
 * stops until a full handshake proves the peer again, which for a client that
 * reconnects daily costs one handshake in seven.
 */
const MAX_AUTHENTICATION_AGE_SECONDS = 604_800;

/**
 * The largest ticket this client will keep.
 *
 * `opaque ticket<1..2^16-1>` allows 65535, and the ClientHello it would ride
 * back in declares its extensions with a uint16 too — so a ticket near that
 * ceiling cannot be ENCODED, and the throw lands on the connection AFTER the one
 * that received it, out of a session the caller has already stored. A ticket the
 * next ClientHello cannot carry is not a session, and refusing it here is the
 * only place that decision is made once.
 *
 * 16KiB is far above anything real: RFC 8448's ticket is 178 octets, and
 * OpenSSL and BoringSSL mint a few hundred. It coincides with a record's
 * capacity and is not derived from it — the limit being dodged is the uint16
 * extension block, roughly four times larger. A ticket at this ceiling still
 * overruns one record, which is what keeps the fragmenting writer exercised.
 */
const MAX_TICKET_BYTES = 16_384;

/**
 * RFC 9846 §4.7.1's `PSK = HKDF-Expand-Label(resumption_secret, "resumption",
 * ticket_nonce, Hash.length)` — 9846 renamed it, and 8446's
 * `resumption_master_secret` appears nowhere in the newer document — or
 * `undefined` for a ticket that
 * could never be used, which is a different thing from one that has expired
 * since. Both live here because both are properties of the ticket's own fields,
 * and a caller handed a session it can never offer has been given a liability to
 * store rather than a session.
 */
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
  /**
   * Three ways a ticket is not a session at all: no window to be used in, too
   * large to ride back in a ClientHello, or behind a certificate check already
   * past the ceiling — the last of which a long-held `IDLE` connection reaches
   * on its own, renewing on day 8 of a chain that started at day 0. Refusing
   * here rather than only at `isSessionOfferable` is the difference between a
   * caller storing nothing and a caller storing a liability.
   */
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

/**
 * `| undefined` because the argument is a rehydrated value wearing a type, and
 * a store that dropped the field entirely is the first thing this has to
 * survive rather than throw on.
 */
const isDerChain = (chain: PeerCertificateChain | undefined): boolean =>
  chain?.leafDer instanceof Uint8Array &&
  Array.isArray(chain.intermediateDer) &&
  chain.intermediateDer.every(der => der instanceof Uint8Array);

/**
 * The two fields a `TlsSession` carries that TypeScript cannot vouch for, and
 * the ONE place that decides they are usable.
 *
 * A session is a value the caller stored and revived, so its type is a claim
 * rather than a fact. JSON is the ordinary way it becomes false: a
 * `SignatureScheme` comes back as a string that is no longer a scheme we
 * implement, and a `Uint8Array` comes back as `{"0":48,...}` — or the field is
 * simply gone. Neither is visible to the compiler and both are typed correctly.
 *
 * **It throws where it is CALLED FROM that matters, and that is `startTls`,
 * before a byte goes out.** A cross-model review found this check living only
 * in `inheritedAuthentication`, which runs after the client's Finished — so a
 * store that had dropped the chain reached `validatePath` with `undefined` and
 * came back out of `startTls` as a raw `TypeError`, mid-handshake, where every
 * other failure in the package is a typed `TlsFailure`. Two other shapes were
 * worse than that one: a JSON-revived chain reached `validatePath` and was
 * refused as `malformed-certificate`, blaming the mail host for a broken store,
 * and with `reverifyOnResume: false` the throw landed AFTER the handshake
 * completed on the wire.
 *
 * It throws rather than returning a `TlsFailure` because it is the CALLER's
 * bug, not the peer's — the same reason an empty `supportedGroups` throws.
 */
export const assertUsableSession = (session: TlsSession): void => {
  if (!SUPPORTED_SIGNATURE_SCHEMES.includes(session.peerSignatureScheme)) {
    throw new Error('the stored session names no signature scheme this client implements');
  }
  if (!isDerChain(session.peerCertificateChain)) {
    throw new Error('the stored session carries no usable peer certificate chain');
  }
};

/**
 * What a connection knows about the peer's identity: WHEN it was proved, by
 * WHICH signature, and over WHICH chain. All three describe the same
 * CertificateVerify, so they are one value rather than three fields that
 * happen to travel together.
 */
export type PeerAuthentication = {
  readonly authenticatedAt: Date;
  readonly peerSignatureScheme: SignatureScheme;
  readonly peerCertificateChain: PeerCertificateChain;
};

/**
 * What the connection ABOUT TO MINT A TICKET should record — and the reason it
 * lives here rather than inline in the handshake.
 *
 * A resumed handshake verifies no SIGNATURE: no Certificate, no
 * CertificateVerify. (It may re-validate the stored chain — `reverifyOnResume`
 * in `handshake.ts` — which is a different claim and does not re-prove the
 * signature.) So it INHERITS, and inheriting is load-bearing. `authenticatedAt` is what
 * `isWithinAuthenticationCeiling` above measures against, and RFC 9846 §4.7.1
 * is explicit about why the measurement exists: "it is possible to continue
 * issuing new tickets which indefinitely extend the lifetime of the keying
 * material originally derived from an initial non-PSK handshake". Take a fresh
 * instant here and every renewed ticket looks newly authenticated, the ceiling
 * never bites, and resumption to a peer outlives the one signature that ever
 * proved it — which in v1 nothing else would catch, because v1 checks no
 * revocation at all.
 *
 * That failure is invisible: the handshake succeeds, the data flows, and the
 * only symptom is a limit silently not applying. It is extracted so the rule
 * has somewhere to be tested, because no peer this package can drive mints a
 * ticket on a resumed connection — see the call site in `handshake.ts`.
 */
export const inheritedAuthentication = (
  resumed: TlsSession | undefined,
  verifiedNow: PeerAuthentication | undefined,
): PeerAuthentication => {
  if (resumed !== undefined) {
    /**
     * The same rehydration check `startTls` already ran on the way in, because
     * this function is reachable without it: it is exported, unit-tested
     * directly, and is where the renewal rule is stated. Running it twice costs
     * two comparisons and removes the question of which caller is responsible.
     */
    assertUsableSession(resumed);
    const { authenticatedAt, peerSignatureScheme, peerCertificateChain } = resumed;
    return { authenticatedAt, peerSignatureScheme, peerCertificateChain };
  }
  if (verifiedNow === undefined) {
    // Unreachable from the handshake: it completes without a CertificateVerify
    // only when resuming, and then `resumed` is set. A guard, not a path.
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

/**
 * RFC 9846 §4.3.11.1: the age we report is the real age in milliseconds plus
 * the server's own random offset, modulo 2^32. The offset is what stops a
 * passive observer tying two connections together by their ticket ages.
 */
export const obfuscatedTicketAge = (session: TlsSession, now: Date): number =>
  (ticketAgeMs(session, now) + session.ticketAgeAdd) % 0x1_0000_0000;

/**
 * DNS names are case-insensitive, so a caller that round-trips a hostname
 * through anything case-normalising would otherwise silently stop resuming.
 *
 * The fold is `@yozz.app/x509`'s own, imported rather than rewritten: it maps A-Z
 * and nothing else, which is exact for an LDH hostname. `String.toLowerCase()`
 * is full Unicode and would WIDEN this comparison — KELVIN SIGN folds to `k` —
 * in a security check whose sibling package refuses to normalise anything it
 * does not have to. An IP is compared as written.
 */
const isSamePeerName = (a: PeerName | null, b: PeerName | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'dns' ? asciiLower(a.value) === asciiLower(b.value) : a.value === b.value;
};

/**
 * Whether a stored session may still go on the wire.
 *
 * The identity checks come first and they are the load-bearing ones: a resumed
 * handshake proves nothing about who the peer is, so the session may only be
 * offered on a connection asking for exactly the identity the issuing
 * connection proved. Same host, and the same `expectedPeerName` policy — an
 * unset one and a `null` one are different answers, and neither may stand in
 * for the other.
 *
 * Then two clocks, because a ticket has two ages. Its own, which the server set
 * a lifetime on; and the age of the CERTIFICATE CHECK behind it, which renewal
 * would otherwise extend forever (§4.7.1). A negative age fails both: it encodes
 * as a huge `obfuscated_ticket_age`, which a server doing 0-RTT anti-replay
 * reads as a replayed ticket.
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
 * RFC 9846 §4.3.11.2's `PskBinderEntry`, "computed in the same way as the
 * Finished message but with the BaseKey being the binder_key".
 *
 * The transcript it runs over is the handshake so far ending in a TRUNCATED
 * ClientHello — everything up to and including the identity list, with the
 * binder list itself cut off. After a HelloRetryRequest that is three messages
 * (`message_hash`, the retry, the truncated second ClientHello), not one, which
 * is why this takes the whole transcript rather than a single message.
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

/**
 * The same ClientHello with its binder filled in.
 *
 * The binder covers the message it travels in, so it cannot be written by the
 * pass that lays the message out — the bytes have to exist first, with the
 * binder's own space zeroed, and then be overwritten. `precedingMessages` is
 * the handshake before this ClientHello: empty for the first one, and the
 * `message_hash` plus the HelloRetryRequest for a retried one.
 */
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
