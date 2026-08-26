/**
 * TLS 1.3 Handshake State Machine and Connection Management (RFC 9846 §4, App. E.4).
 */

import {
  decodeCertificate,
  type PeerName,
  type TrustAnchorSource,
  type ValidationFailure,
  type Validator,
} from '@yozz.app/x509';
import {
  type Alert,
  alertForValidationFailure,
  decodeAlert,
  encodeAlert,
  type TlsFailure,
} from './alert.ts';
import { concat, readUint24 } from './bytes.ts';
import {
  decodeHandshakeMessage,
  type Extension,
  encodeHandshakeMessage,
  encodeProductionClientHello,
} from './handshake-messages.ts';
import {
  CIPHER_SUITES,
  type CipherSuite,
  deriveSecret,
  earlySecret,
  exportKeyingMaterial,
  finishedKey,
  handshakeSecret,
  hkdfExpandLabel,
  isVerifyDataValid,
  masterSecret,
  trafficKeys,
  verifyData,
} from './key-schedule.ts';
import {
  deriveSharedSecret,
  generateKeyShare,
  importPrivateShare,
  type KeySharePair,
} from './key-share.ts';
import { publicKeyPin } from './pinning.ts';
import {
  MAX_RECORD_PLAINTEXT,
  openAead,
  openPlain,
  RecordReader,
  sealAead,
  sealPlain,
} from './record.ts';
import {
  assertUsableSession,
  bindClientHello,
  inheritedAuthentication,
  isSessionOfferable,
  obfuscatedTicketAge,
  type PeerCertificateChain,
  sessionFromTicket,
  type TlsSession,
} from './session.ts';
import { Transcript } from './transcript.ts';
import type { ByteDuplex } from './transport.ts';
import { verifyCertificateVerify } from './verify.ts';
import {
  DOWNGRADE_SENTINEL_TLS_1_1,
  DOWNGRADE_SENTINEL_TLS_1_2,
  EXTENSION_TYPES,
  HRR_MAGIC_RANDOM,
  LEGACY_RECORD_VERSION,
  NAMED_GROUPS,
  type NamedGroup,
  namedGroupFromCode,
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  signatureSchemeFromCode,
  TLS_VERSION,
} from './wire.ts';

export type StartTlsOptions = {
  readonly transport: ByteDuplex;
  readonly serverName: string;
  readonly trustAnchors: TrustAnchorSource;
  readonly validationTime: Date;
  readonly validator: Validator;
  readonly expectedPeerName?: PeerName | null;
  /**
   * What `supported_groups` offers, in preference order — the first carries the
   * key share. Defaults to every group we implement.
   */
  readonly supportedGroups?: readonly NamedGroup[];
  /**
   * What `signature_algorithms` offers, in preference order. Defaults to every
   * scheme we implement.
   *
   * It is a security boundary as much as a preference: RFC 9846 §4.5.2 says a
   * server's CertificateVerify "signature algorithm MUST be one offered in the
   * client's `signature_algorithms` extension", and a scheme left out of this
   * list is one the handshake below refuses with `illegal_parameter`.
   */
  readonly signatureSchemes?: readonly SignatureScheme[];
  /**
   * A session from an earlier connection to this same host, to offer for
   * resumption. One is offered, not a list: a client that cannot tell which of
   * its tickets a server will take is guessing, and every guess it sends is
   * another identifier on the wire in the clear.
   *
   * **Offer each session once.** RFC 9846 App. C.4: "Clients SHOULD NOT reuse a
   * ticket for multiple connections. Reuse of a ticket allows passive observers
   * to correlate different connections." The ticket travels in the clear, so a
   * store that keeps handing back the same one turns it into a tracking cookie.
   * Nothing here can enforce that — the store is the caller's — so the caller
   * evicts what it passed in and keeps whatever `onSession` hands back.
   *
   * A session is refused unless `serverName` and `expectedPeerName` match the
   * connection that issued it, because a resumed handshake re-proves neither.
   * `trustAnchors` and `validator` are NOT part of that binding: today they are
   * the same on every connection — ARCHITECTURE.md pins one root bundle — and
   * the day they vary per account they have to join it.
   */
  readonly session?: TlsSession;
  /**
   * Whether a resumed handshake validates the session's stored chain again,
   * against today's clock and today's trust anchors. **Defaults to `true`.**
   *
   * A resumed handshake proves the peer holds the pre-shared key and nothing
   * else: no Certificate, no CertificateVerify. So without this the certificate
   * decision is the one made on the connection that issued the ticket, and the
   * only thing bounding how stale it may be is
   * `MAX_AUTHENTICATION_AGE_SECONDS` — a week. Re-validating narrows that to
   * the reconnect: a leaf that expired an hour ago, or a root an app update
   * stopped shipping, is refused now rather than within seven days.
   *
   * **It is not a substitute for that ceiling and does not retire it.** The
   * ceiling bounds the age of the SIGNATURE, which nothing on a resumed wire
   * re-proves; this bounds the validity of the CHAIN, which the stored copy
   * still answers for. Two different claims, both needed.
   *
   * **Failure is a refused connection, not a quiet full handshake.** The
   * session has already been accepted by the server by the time this runs, and
   * a client that silently reconnected without it would turn "your stored chain
   * no longer validates" into a fact nothing observes. What the caller gets
   * instead is `{ kind: 'certificate', chain: 'session-stored' }` — and that
   * `chain` field is the whole reason the refusal is usable: it separates a
   * stale STORED chain, where evicting the session and reconnecting is very
   * likely to work because the host has rotated, from a peer-sent chain we
   * refuse, where retrying earns a second refusal. The store is the caller's,
   * so the eviction is too.
   *
   * Default `true` because a check that must be asked for is a check that gets
   * forgotten. BoringSSL's default is the other way and `-reverify-on-resume`
   * turns it on, so the BoGo shim passes `false` explicitly.
   */
  readonly reverifyOnResume?: boolean;
  /**
   * Called once per `NewSessionTicket`, which in TLS 1.3 arrive AFTER the
   * handshake — so this fires from `read()`, not from `startTls`. Without it no
   * derivation runs and the tickets are dropped where they are read.
   */
  readonly onSession?: (session: TlsSession) => void | Promise<void>;
  /**
   * The client's clock, read whenever the AGE of a resumption ticket matters:
   * once when a ticket arrives, and once per ClientHello that offers one.
   *
   * Deliberately not `validationTime`. That one is a POLICY input — the instant
   * to validate a chain as of — and a caller may legitimately freeze or backdate
   * it; a frozen clock here would report every ticket as brand new and go on
   * offering one long past its lifetime. This is the running clock, and it is
   * injectable because BoGo compares the reported age to `-resumption-delay` for
   * exact equality. Defaults to the real one.
   */
  readonly now?: () => Date;
};

export type HandshakeResult =
  | {
      readonly ok: true;
      readonly connection: TlsConnection;
      /** The group the key exchange actually ran on, which a HelloRetryRequest can change. */
      readonly negotiatedGroup: NamedGroup;
      /** Whether the server took the offered session, skipping its certificate. */
      readonly isResumed: boolean;
      /** Whether the server asked for a second ClientHello before answering. */
      readonly isHelloRetryRequested: boolean;
      /**
       * The scheme the server signed its CertificateVerify with — a NAME, like
       * `negotiatedGroup`, because by the time it is set the handshake has
       * already refused every code outside the offered list.
       *
       * A resumed handshake sends no CertificateVerify, so this is restored from
       * the session — it names the signature that authenticated the peer, which
       * on a resumption is the one from the connection that issued the ticket.
       */
      readonly peerSignatureScheme: SignatureScheme;
      /**
       * The pin for the key that authenticated this peer — RFC 7469's base64
       * SHA-256 over the leaf's SubjectPublicKeyInfo — taken from the path the
       * validator vouched for rather than re-derived from the wire.
       *
       * It is HERE, on a completed handshake, and nowhere else on purpose. A
       * pin learned any earlier is a pin learned from bytes that chain to a
       * trusted root and nothing more, which anyone on the path can send; only
       * CertificateVerify and Finished prove the peer HOLDS the key, and both
       * land after the last validation this connection performs. Trust on first
       * use therefore reads this field, and a caller cannot reach it from a
       * handshake that failed.
       *
       * `null` on a resumed handshake with `reverifyOnResume` off — the one
       * configuration in which this connection validated no chain at all, so
       * there is nothing it can honestly report. Every other path sets it,
       * including a resumption that re-checked its stored chain, where the key
       * that authenticated the peer is the stored leaf's.
       */
      readonly peerPublicKeyPin: string | null;
    }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsConnection = {
  readonly read: () => Promise<TlsReadResult>;
  readonly write: (plaintext: Uint8Array) => Promise<TlsWriteResult>;
  readonly close: () => Promise<TlsCloseResult>;
  /**
   * RFC 9846 §7.5's exporter — key material derived from this connection for
   * something outside it, bound to a label and a context the caller chooses.
   *
   * Channel binding is what YOZZ will want it for: SCRAM-SHA-256-PLUS proves
   * to the mail server that the TLS connection carrying the SASL exchange is
   * the same one the client believes it is on, and `tls-exporter` (RFC 9266) is
   * the TLS 1.3 binding.
   *
   * **`label` may not be empty.** It becomes `HkdfLabel.label` as `"tls13 " +
   * label`, and RFC 9846 §7.1 declares that field `opaque label<7..255>`, so
   * six octets is not encodable. It rejects rather than deriving a key from a
   * struct that could not go on a wire.
   */
  readonly exportKeyingMaterial: (
    label: string,
    context: Uint8Array,
    length: number,
  ) => Promise<Uint8Array>;
};

export type TlsReadResult =
  | { readonly ok: true; readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly ok: true; readonly kind: 'closed' }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsCloseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TlsFailure };

export type InternalReplayHooks = {
  readonly clientHelloMessages: readonly Uint8Array[];
  readonly clientEphemeralPrivateKeys: readonly Uint8Array[];
};

/**
 * How large a handshake message we will buffer.
 *
 * `Handshake.length` is a uint24, so the RFC's own ceiling is 16MB — which is
 * 16MB a peer can make us hold before we are able to check a single byte of it.
 * The cap is ours to choose, and 16KB was too small: BoGo's `LargeMessage`
 * sends a 51-certificate chain of about 23KB and expects it to arrive, and a
 * real chain of ML-DSA certificates would be larger still.
 */
const MAX_HANDSHAKE_MESSAGE_BODY = 65536;

/**
 * Ceilings on records that carry the conversation nowhere.
 *
 * TLS 1.3 sets none of these. A peer may send zero-length application records
 * as a traffic-analysis countermeasure (RFC 9846 §5.4), `user_canceled` alerts
 * are warnings to be ignored (§6.1), and `KeyUpdate` has no rate — so a peer
 * that sends any of them forever costs us everything and itself nothing. The
 * numbers are BoringSSL's, adopted exactly because BoGo pins them from both
 * sides: 32 empty fragments must pass and 33 must fail, 4 `user_canceled` must
 * pass and 5 must fail.
 *
 * All three count CONSECUTIVE occurrences and reset the moment a byte of
 * application data is delivered — BoringSSL's own rule, in as many words:
 * "Only when at least one byte is returned, clear the counters for empty
 * records and warnings" (`ssl/tls_record.cc`), with `key_update_count` cleared
 * on delivered data in `ssl/ssl_lib.cc`. Counting them over the connection's
 * LIFETIME instead would kill a perfectly ordinary IMAP session on its 33rd
 * rekey, hours in, which is exactly the connection this client is for.
 */
const MAX_CONSECUTIVE_EMPTY_RECORDS = 32;
const MAX_WARNING_ALERTS = 4;
const MAX_KEY_UPDATES = 32;
/**
 * `NewSessionTicket` belongs on that list too, and BoGo pins no number for it,
 * so this one is ours. It is the same shape of abuse — a post-handshake message
 * a peer may send at will, which `read()` answers by looping instead of
 * returning — with a sharper edge than the others: each ticket now costs an HKDF
 * expansion AND a call into the caller's own storage. A peer that sends them
 * forever starves the read the application is waiting on.
 *
 * 32 is far above anything real. OpenSSL, BoringSSL and Node all send two.
 */
const MAX_CONSECUTIVE_SESSION_TICKETS = 32;

/**
 * What the server may answer with, per message.
 *
 * RFC 9846 §4.3 is flat about it: an endpoint MUST NOT send an extension
 * response the peer did not request, and one that arrives anyway is fatal —
 * `unsupported_extension`. So the test is TWO things at once, and both matter:
 * the extension has to be one we actually offered, AND one defined for the
 * message it turned up in.
 *
 * Matched by TYPE CODE rather than by our decoder's `kind`, because everything
 * we do not model decodes to `unknown` and two different unknowns would
 * otherwise look alike.
 *
 * The lists are RFC 9846 §4.3's table, plus RFC 8449's `record_size_limit`.
 * A `CertificateEntry` carries only responses to offers this client does not
 * make, so in practice nothing may appear there at all.
 */
const PERMITTED_IN_SERVER_HELLO = [
  41, // pre_shared_key
  43, // supported_versions
  51, // key_share
];

const PERMITTED_IN_ENCRYPTED_EXTENSIONS = [
  0, // server_name
  1, // max_fragment_length
  10, // supported_groups
  14, // use_srtp
  15, // heartbeat
  16, // application_layer_protocol_negotiation
  19, // client_certificate_type
  20, // server_certificate_type
  28, // record_size_limit
  42, // early_data
];

const PERMITTED_IN_CERTIFICATE_ENTRY = [
  5, // status_request
  18, // signed_certificate_timestamp
];

/** A HelloRetryRequest's cookie answers no offer — the server starts that one. */
const COOKIE = 44;

/**
 * How large a cookie we will echo back.
 *
 * A ClientHello's extensions are `Extension extensions<8..2^16-1>` — the whole
 * BLOCK is a uint16 — and a cookie is `opaque cookie<1..2^16-1>` chosen by the
 * server. So a cookie near its own legal maximum makes a ClientHello that CANNOT
 * BE ENCODED at all, by anyone; the limit is the wire format's, not ours, and
 * fragmenting records does not touch it.
 *
 * That draws the line this file follows: an input the PEER sizes gets a typed
 * failure, an input the CALLER sizes is allowed to throw. A ticket is bounded
 * where it is stored (`MAX_TICKET_BYTES`), and the cookie here — 16KiB leaves
 * room for the largest ticket we keep and every other extension several times
 * over. Real cookies are tens of bytes; they carry a server's stateless retry
 * state, not data.
 */
const MAX_ECHOED_COOKIE_BYTES = 16_384;

/**
 * A HelloRetryRequest is NOT a ServerHello for this purpose.
 *
 * RFC 9846's Table 1 gives each extension the messages it may appear in, and HRR
 * is a column of its own: `supported_versions` and `key_share` are `CH, SH, HRR`
 * and `cookie` is `CH, HRR`, while `pre_shared_key` is `CH, SH` — excluded from
 * the retry on purpose. Reusing the ServerHello list plus a cookie was right
 * until this client offered a PSK; from then on 41 was in the offered set AND in
 * the permitted one, so a retry carrying `pre_shared_key` passed both halves of
 * the check and was silently ignored. §4.3 makes it `illegal_parameter`.
 */
const PERMITTED_IN_HELLO_RETRY_REQUEST = [
  43, // supported_versions
  COOKIE,
  51, // key_share
  // Table 1 gives `encrypted_client_hello [RFC9849]` the messages `CH, HRR, EE`
  // too. Absent on purpose: this client never offers ECH, so one arriving is a
  // response to nothing and earns `unsupported_extension` before this list is
  // consulted. It belongs here the day ECH is offered.
];

const extensionTypeCode = (extension: Extension): number =>
  extension.kind === 'unknown' ? extension.typeCode : EXTENSION_TYPES[extension.kind];

/**
 * Which alert a server extension has earned, if any. RFC 9846 §4.3 draws a line
 * between two failures that look alike and are not:
 *
 *  - an extension we never offered is a response to nothing —
 *    `unsupported_extension`;
 *  - an extension we DID offer, turning up in a message where that extension is
 *    not defined, is a misplaced one — `illegal_parameter`.
 */
const misplacedExtensionAlert = (
  extensions: readonly Extension[],
  offered: ReadonlySet<number>,
  permitted: readonly number[],
): Alert['description'] | null => {
  for (const extension of extensions) {
    const code = extensionTypeCode(extension);
    if (!offered.has(code)) return 'unsupported_extension';
    if (!permitted.includes(code)) return 'illegal_parameter';
  }
  return null;
};

const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const expectedKeyShareLength = (group: NamedGroup): number => {
  if (group === 'x25519') return 32;
  if (group === 'secp256r1') return 65;
  return 97;
};

const suiteFromCode = (code: number): CipherSuite | undefined => {
  if (code === 0x1301) return 'TLS_AES_128_GCM_SHA256';
  if (code === 0x1302) return 'TLS_AES_256_GCM_SHA384';
  return undefined;
};

/**
 * What a session looks like in a ClientHello, with the binder still to come.
 *
 * The caller passes the instant rather than this reading a clock, because the
 * two ClientHellos want different answers: the first is built from the same
 * reading that decided the session was offerable at all, and the retried one
 * from a fresh reading, which RFC 9846 §4.2.2 asks for in as many words.
 */
const pskOffer = (
  session: TlsSession | undefined,
  now: Date,
): { identity: Uint8Array; obfuscatedTicketAge: number; binderLength: number } | undefined =>
  session === undefined
    ? undefined
    : {
        identity: session.ticket,
        obfuscatedTicketAge: obfuscatedTicketAge(session, now),
        binderLength: CIPHER_SUITES[session.suite].hashLength,
      };

const rebindTranscript = (suite: CipherSuite, previous: Transcript): Transcript => {
  const next = new Transcript(suite);
  for (const message of previous.getMessages()) {
    next.add(message);
  }
  return next;
};

/**
 * A ClientHello as records, fragmented if it does not fit in one.
 *
 * RFC 9846 §5.1 allows it — "Handshake messages MAY be coalesced into a single
 * TLSPlaintext record or fragmented across several records" — and this client
 * needs it, because two of the things that go INTO a ClientHello are sized by
 * the peer. A ticket is `opaque ticket<1..2^16-1>` (§4.7.1) and comes back as
 * the PSK identity; a HelloRetryRequest cookie is `opaque cookie<1..2^16-1>`
 * (§4.3.2) and comes back echoed. Either at its legal maximum overruns a single
 * record, and `sealPlain` answers that by THROWING — so a server could hand us a
 * 16KB ticket and poison the next connection before a byte went out.
 *
 * The legacy record version rides on every fragment: §5.1 deprecates the field
 * and requires it ignored, so the only thing that matters is the middlebox
 * compatibility the first ClientHello's 0x0301 buys, and a fragment of that
 * message is still that message.
 */
const clientHelloRecords = (message: Uint8Array, legacyVersion: number): readonly Uint8Array[] =>
  Array.from({ length: Math.ceil(message.length / MAX_RECORD_PLAINTEXT) }, (_, index) =>
    sealPlain(
      'handshake',
      message.subarray(index * MAX_RECORD_PLAINTEXT, (index + 1) * MAX_RECORD_PLAINTEXT),
      legacyVersion,
    ),
  );

type ExtractResult =
  | { readonly kind: 'message'; readonly bytes: Uint8Array }
  | { readonly kind: 'need-more' }
  | { readonly kind: 'overflow' };

/**
 * The state machine, with the replay hooks as a second argument. Exported for
 * `replay.ts` and for nothing else, which `index.test.ts` enforces by name: the
 * import guard on `replay.ts` cannot see a production file that reaches past it
 * to here.
 */
export const runHandshake = async (
  options: StartTlsOptions,
  replay?: InternalReplayHooks,
): Promise<HandshakeResult> => {
  const { transport, serverName } = options;
  const now = options.now ?? (() => new Date());
  /**
   * The identity the chain is checked against, resolved once. It is what the
   * session is bound to, so it has to be the SAME expression the validator is
   * given — computing it twice is how the two come to disagree.
   */
  const expectedPeerName =
    options.expectedPeerName !== undefined
      ? options.expectedPeerName
      : ({ kind: 'dns', value: serverName } as const);
  /**
   * Before a byte goes out, and deliberately before `isSessionOfferable` gets a
   * say. A session is a value the caller stored and revived, so the two fields
   * TypeScript cannot vouch for are checked at the door — see
   * `assertUsableSession`, and the review that moved it here from a call site
   * one flight too late.
   *
   * Unconditional rather than only-if-we-would-offer-it: a session whose shape
   * did not survive the store is the caller's bug whether or not this
   * connection would have used it, and finding out on the connection that
   * happens to match is finding out late.
   */
  if (options.session !== undefined) {
    assertUsableSession(options.session);
  }
  let transcript = new Transcript();
  const reader = new RecordReader(() => transport.read());

  // One reassembly buffer spanning every path (pre-key, encrypted flight, post-handshake).
  const handshakeBuffer: Uint8Array[] = [];

  const extractNextHandshakeMessage = (): ExtractResult => {
    const combined = concat(...handshakeBuffer);
    if (combined.length < 4) return { kind: 'need-more' };
    const length = readUint24(combined, 1);
    if (length > MAX_HANDSHAKE_MESSAGE_BODY) return { kind: 'overflow' };
    if (combined.length < 4 + length) return { kind: 'need-more' };
    const msgBytes = combined.subarray(0, 4 + length);
    const remainder = combined.subarray(4 + length);
    handshakeBuffer.length = 0;
    if (remainder.length > 0) {
      handshakeBuffer.push(remainder);
    }
    return { kind: 'message', bytes: msgBytes };
  };

  type WriteKeys = {
    key: Uint8Array;
    iv: Uint8Array;
    seq: bigint;
  };

  // Current client write keys for protected alerts. Null before ServerHello keys exist.
  let clientWriteKeys: WriteKeys | null = null;

  /**
   * The compatibility-mode ChangeCipherSpec, owed once we send a non-empty
   * legacy_session_id and paid exactly once.
   *
   * RFC 9846 D.4 puts it "immediately before the second flight", and the second
   * flight is whatever we protect first: a retried ClientHello, the Finished
   * flight, or a fatal alert when the handshake ends early. Sending it only
   * before Finished left every aborted handshake without it, and a peer that
   * expects a middlebox-friendly stream reads the alert that follows as a
   * malformed ChangeCipherSpec instead of the alert it is.
   */
  let compatibilityCcsPending = false;

  const sendCompatibilityCcsIfPending = async (): Promise<void> => {
    if (!compatibilityCcsPending) return;
    compatibilityCcsPending = false;
    await transport.write(sealPlain('change_cipher_spec', Uint8Array.of(1)));
  };

  /**
   * A peer that hangs up mid-handshake is a truncated connection, not a bug in
   * this file. `ByteDuplex.write` rejects when the socket has gone, and letting
   * that escape turned "the server closed on us" into an unhandled error with a
   * stack trace where a typed failure belongs.
   */
  const writeToPeer = async (record: Uint8Array): Promise<boolean> => {
    try {
      await transport.write(record);
      return true;
    } catch {
      return false;
    }
  };

  const sendFatalAlert = async (description: Alert['description']): Promise<void> => {
    try {
      const alertBytes = encodeAlert({ level: 'fatal', description });
      if (clientWriteKeys === null) {
        // Cleartext, so nothing is owed yet: the dummy record belongs before the
        // first PROTECTED thing we write.
        await transport.write(sealPlain('alert', alertBytes));
        return;
      }
      await sendCompatibilityCcsIfPending();
      const sealed = await sealAead(
        clientWriteKeys.key,
        clientWriteKeys.iv,
        clientWriteKeys.seq,
        'alert',
        alertBytes,
      );
      clientWriteKeys = {
        key: clientWriteKeys.key,
        iv: clientWriteKeys.iv,
        seq: clientWriteKeys.seq + 1n,
      };
      await transport.write(sealed);
    } catch {
      // Ignore transport write errors when aborting.
    }
  };

  const failAlert = async (description: Alert['description']): Promise<HandshakeResult> => {
    await sendFatalAlert(description);
    return {
      ok: false,
      reason: {
        kind: 'alert-sent',
        alert: { level: 'fatal', description },
      },
    };
  };

  /**
   * Every path validation this connection performs, at both the sites that
   * perform one — the peer's Certificate on a full handshake, and the stored
   * chain again on a resumed one. Written once because the two must ask the
   * same question: a re-check under a laxer policy than the original would
   * report a chain as still good on terms it was never accepted on.
   */
  const validatePeerChain = (chain: PeerCertificateChain) =>
    options.validator.validatePath({
      peerCertificateDer: chain.leafDer,
      untrustedIntermediateDer: chain.intermediateDer,
      trustAnchors: options.trustAnchors,
      validationTime: options.validationTime,
      expectedPeerName,
      requiredKeyUsages: ['digitalSignature'],
      // NAMES, not OIDs. `@yozz.app/x509` looks these up in its own table, so an
      // OID here silently matches nothing and every real chain is refused with
      // `extended-key-usage-violation`. The scripted-peer tests never caught it
      // because they run a test validator instead of YOZZ_VALIDATOR.
      requiredExtendedKeyUsages: ['serverAuth'],
      maximumIntermediateCount: null,
    });

  const failValidation = async (
    reason: ValidationFailure,
    chain: 'peer-sent' | 'session-stored',
  ): Promise<HandshakeResult> => {
    const alert = alertForValidationFailure(reason);
    await sendFatalAlert(alert.description);
    return { ok: false, reason: { kind: 'certificate', reason, alert, chain } };
  };

  /**
   * What we offer, and which of them carries the share. The RFC calls the
   * second one out separately (§4.3.8): a HelloRetryRequest may only move us to
   * a group we offered and did NOT already share, so both facts are needed.
   */
  /**
   * COPIED, not aliased. The list is read twice — once for ClientHello1 and
   * again for the ClientHello a HelloRetryRequest asks for, a full round trip
   * later — and RFC 9846 §4.2.4 requires the second to offer what the first
   * did. A caller holding a mutable array could otherwise change it in between,
   * or after the checks below have already passed on it.
   */
  const offeredGroups = [...(options.supportedGroups ?? SUPPORTED_GROUPS)];
  const firstOfferedGroup = offeredGroups[0];
  if (firstOfferedGroup === undefined) {
    throw new Error('supportedGroups must offer at least one group');
  }
  /**
   * RFC 9846 §4.3.7: "The `named_group_list` MUST NOT contain any duplicate
   * entries. A recipient MAY abort a connection with a fatal
   * `illegal_parameter` alert if it detects a duplicate entry." So a repeat is
   * a ClientHello a conforming peer may hang up on, and the caller would see it
   * as an unexplained server-side refusal. It throws rather than returning a
   * typed failure because it is OUR bug, not the peer's — the same reason the
   * empty case above does.
   */
  if (new Set(offeredGroups).size !== offeredGroups.length) {
    throw new Error('supportedGroups must not repeat a group');
  }

  /**
   * COPIED and checked for the same reasons as the groups above: the list is
   * read again for the ClientHello a HelloRetryRequest asks for, and again when
   * the CertificateVerify arrives to decide whether the server signed with
   * something we offered. §4.3.3 gives `supported_signature_algorithms` a
   * `<2..2^16-2>` bound, so an empty list is not encodable; a repeat is our bug
   * either way, which is why both throw rather than returning a typed failure.
   *
   * **This one stays the CALLER'S list, where `offeredExtensionCodes` and
   * `offeredGroupCodes` below are read back off the ClientHello we sent.** Those
   * two decide whether the server's ANSWER was solicited, and a constant would
   * refuse the replayed document's own server. This decides whether a SIGNATURE
   * is one we would accept, and the two diverge in the direction that matters:
   * if the encoder ever failed to narrow what went out, reading the wire would
   * make us accept the wider set silently, while reading the option refuses and
   * the interop failure is visible. The caller's policy binds what we accept
   * even when the bytes disagree. BoGo holds the wire's half of it — narrow the
   * offer with `-verify-prefs` and `VerifyPreferences-Advertised` reads the
   * extension back.
   */
  const offeredSchemes = [...(options.signatureSchemes ?? SUPPORTED_SIGNATURE_SCHEMES)];
  if (offeredSchemes.length === 0) {
    throw new Error('signatureSchemes must offer at least one scheme');
  }
  if (new Set(offeredSchemes).size !== offeredSchemes.length) {
    throw new Error('signatureSchemes must not repeat a scheme');
  }

  // 1. Generate ephemeral share and send ClientHello1
  let clientShare: KeySharePair;
  let ch1MessageBytes: Uint8Array;
  let sentSessionId: Uint8Array;
  let ch1Random: Uint8Array;
  /** The group our CURRENT share is on — reassigned only by a HelloRetryRequest. */
  let effectiveGroupName: NamedGroup;
  /**
   * The session the ClientHello on the wire actually carries — `undefined` when
   * there is none to offer, when the one we hold is for another host or past its
   * lifetime, and when a HelloRetryRequest moves us to a hash it cannot bind
   * under. Everything downstream reads it as "did we ask to resume", so it has
   * to mean the message we sent rather than the one we considered sending.
   */
  let offeredSession: TlsSession | undefined;

  if (replay !== undefined) {
    const ch1 = replay.clientHelloMessages[0];
    const priv = replay.clientEphemeralPrivateKeys[0];
    if (ch1 === undefined || priv === undefined) {
      throw new Error('Replay missing ClientHello1 or private key');
    }
    ch1MessageBytes = ch1;
    // RFC 8448's ClientHello shares x25519, whatever this client would offer.
    effectiveGroupName = 'x25519';
    clientShare = await importPrivateShare(effectiveGroupName, priv);
    const decodedCh1 = decodeHandshakeMessage(ch1);
    if (!decodedCh1.ok || decodedCh1.value.kind !== 'client_hello') {
      throw new Error('Malformed replay ClientHello1');
    }
    sentSessionId = decodedCh1.value.legacySessionId;
    ch1Random = decodedCh1.value.random;
    /**
     * A replayed trace can be a RESUMED one, and until §4 was driven through
     * here nothing had noticed: this branch was written for §3 and §5, both full
     * handshakes, and left `offeredSession` unset. The document's ClientHello
     * then went out carrying `pre_shared_key` while the state machine believed
     * it had offered no session, so the server's acceptance answered an offer
     * this side did not think it had made.
     *
     * Gated by `isSessionOfferable` exactly as the production branch is, rather
     * than taking the caller's session on trust — a replay that offers a session
     * the rules would have refused proves the wrong thing.
     */
    offeredSession =
      options.session !== undefined &&
      isSessionOfferable(options.session, serverName, expectedPeerName, now())
        ? options.session
        : undefined;
  } else {
    effectiveGroupName = firstOfferedGroup;
    clientShare = await generateKeyShare(effectiveGroupName);
    sentSessionId = crypto.getRandomValues(new Uint8Array(32));
    ch1Random = crypto.getRandomValues(new Uint8Array(32));
    const offeredAt = now();
    offeredSession =
      options.session !== undefined &&
      isSessionOfferable(options.session, serverName, expectedPeerName, offeredAt)
        ? options.session
        : undefined;
    ch1MessageBytes = encodeProductionClientHello({
      serverName,
      keySharePublicKey: clientShare.publicKey,
      group: effectiveGroupName,
      supportedGroups: offeredGroups,
      signatureSchemes: offeredSchemes,
      legacySessionId: sentSessionId,
      random: ch1Random,
      psk: pskOffer(offeredSession, offeredAt),
    });
    if (offeredSession !== undefined) {
      ch1MessageBytes = await bindClientHello(offeredSession, ch1MessageBytes, []);
    }
  }

  /**
   * What we offered, read back off the ClientHello we actually SENT rather than
   * from the values beside it — the replay path sends RFC 8448's ClientHello,
   * whose offers are not ours, and a constant here would refuse the document's
   * own server. That applies to the GROUPS as much as to the extension codes:
   * `offeredGroups` is what this client would have offered, not what the bytes
   * on the wire did.
   */
  const [offeredExtensionCodes, offeredGroupCodes] = ((): [
    ReadonlySet<number>,
    ReadonlySet<number>,
  ] => {
    const decoded = decodeHandshakeMessage(ch1MessageBytes);
    if (!decoded.ok || decoded.value.kind !== 'client_hello') {
      throw new Error('our own ClientHello does not decode');
    }
    const groups = decoded.value.extensions.find(e => e.kind === 'supported_groups');
    return [
      new Set(decoded.value.extensions.map(extensionTypeCode)),
      new Set(groups?.kind === 'supported_groups' ? groups.groups : []),
    ];
  })();

  compatibilityCcsPending = sentSessionId.length > 0;

  transcript.add(ch1MessageBytes);
  for (const record of clientHelloRecords(
    ch1MessageBytes,
    LEGACY_RECORD_VERSION.FIRST_CLIENT_HELLO,
  )) {
    if (!(await writeToPeer(record))) {
      return { ok: false, reason: { kind: 'truncated' } };
    }
  }

  // 2. Read ServerHello (or HRR), reassembling across plaintext record boundaries
  let hasSeenHrr = false;
  let negotiatedSuite: CipherSuite | undefined;
  let hrrSelectedSuite: CipherSuite | undefined;
  let serverShareKeyExchange: Uint8Array | undefined;
  let realServerHelloBytes: Uint8Array | undefined;
  /** The offered session, once the server has said it took it. */
  let resumedSession: TlsSession | undefined;

  while (realServerHelloBytes === undefined) {
    let extracted = extractNextHandshakeMessage();
    while (extracted.kind === 'need-more') {
      const recResult = await reader.readRecord();
      if (!recResult.ok) {
        if (recResult.kind === 'truncated') {
          return { ok: false, reason: { kind: 'truncated' } };
        }
        return failAlert(recResult.description);
      }

      if (recResult.kind === 'eof') {
        return { ok: false, reason: { kind: 'truncated' } };
      }

      const record = recResult.record;
      if (record[0] === 0x14) {
        continue;
      }

      if (record[0] === 0x17) {
        return failAlert('unexpected_message');
      }

      const plainRes = openPlain(record);
      if (!plainRes.ok) {
        return failAlert(plainRes.description);
      }

      /**
       * A server that refuses the ClientHello says so with a cleartext alert —
       * `protocol_version` when it speaks no TLS 1.3, `handshake_failure` when
       * it shares no cipher. Answering with our own `unexpected_message` threw
       * away the only sentence in the exchange that says WHY, and a
       * self-hosted user's report of "unexpected message" is undiagnosable.
       */
      if (plainRes.type === 'alert') {
        const alertRes = decodeAlert(plainRes.payload);
        if (alertRes.ok) {
          return { ok: false, reason: { kind: 'alert-received', alert: alertRes.alert } };
        }
        if (alertRes.unknownDescriptionCode !== undefined) {
          return {
            ok: false,
            reason: { kind: 'alert-received-unknown', code: alertRes.unknownDescriptionCode },
          };
        }
        return failAlert(alertRes.description);
      }

      if (plainRes.type !== 'handshake') {
        return failAlert('unexpected_message');
      }

      handshakeBuffer.push(plainRes.payload);
      extracted = extractNextHandshakeMessage();
    }

    if (extracted.kind === 'overflow') {
      return failAlert('decode_error');
    }

    const shBytes = extracted.bytes;
    const decoded = decodeHandshakeMessage(shBytes);
    if (!decoded.ok) {
      return failAlert(decoded.description);
    }

    const msg = decoded.value;
    if (msg.kind !== 'server_hello') {
      return failAlert('unexpected_message');
    }

    // ServerHello invariants (RFC 9846 §4.2.3). legacy_version is checked in the
    // decoder, two bytes in, because an SSL 3.0 ServerHello has no extensions
    // block to parse and the version is what says so.
    if (msg.legacyCompressionMethod !== 0) {
      return failAlert('illegal_parameter');
    }
    if (!isSameBytes(msg.legacySessionIdEcho, sentSessionId)) {
      return failAlert('illegal_parameter');
    }

    // Downgrade sentinels check
    const random = msg.random;
    const randomSuffix = random.subarray(24);
    if (
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_2) ||
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_1)
    ) {
      return failAlert('illegal_parameter');
    }

    /**
     * supported_versions must say 0x0304 — and after a HelloRetryRequest it must
     * say the SAME thing it said there. RFC 9846 §4.2.4: "The value of
     * selected_version in the HelloRetryRequest supported_versions extension
     * MUST be retained in the ServerHello, and a client MUST abort the
     * handshake with an illegal_parameter alert if the value changes."
     *
     * Since 0x0304 is the only value this client ever accepts, "changed" and
     * "absent or not 0x0304" are the same test; only the alert differs, and
     * which alert is the whole of what the peer learns.
     */
    const versionsExt = msg.extensions.find(e => e.kind === 'supported_versions');
    const wrongVersionAlert = hasSeenHrr ? 'illegal_parameter' : 'protocol_version';
    if (versionsExt === undefined || versionsExt.kind !== 'supported_versions') {
      return failAlert(wrongVersionAlert);
    }
    const selectedVersion = versionsExt.versions[0];
    if (selectedVersion !== TLS_VERSION.V1_3) {
      return failAlert(wrongVersionAlert);
    }

    // A pre_shared_key we never offered needs no special case: it is an
    // extension response to a request we did not make, like any other.
    const serverHelloExtensionAlert = misplacedExtensionAlert(
      msg.extensions,
      // The cookie is the server's own, so it counts as offered.
      new Set([...offeredExtensionCodes, COOKIE]),
      isSameBytes(msg.random, HRR_MAGIC_RANDOM)
        ? PERMITTED_IN_HELLO_RETRY_REQUEST
        : PERMITTED_IN_SERVER_HELLO,
    );
    if (serverHelloExtensionAlert !== null) {
      return failAlert(serverHelloExtensionAlert);
    }

    const selectedSuite = suiteFromCode(msg.cipherSuite);
    if (selectedSuite === undefined) {
      return failAlert('illegal_parameter');
    }

    // Post-HRR ServerHello must keep the suite HRR selected
    if (hrrSelectedSuite !== undefined && selectedSuite !== hrrSelectedSuite) {
      return failAlert('illegal_parameter');
    }

    negotiatedSuite = selectedSuite;
    transcript = rebindTranscript(negotiatedSuite, transcript);

    const keyShareExt = msg.extensions.find(e => e.kind === 'key_share');
    const cookieExt = msg.extensions.find(e => e.kind === 'cookie');
    const isHrr = isSameBytes(msg.random, HRR_MAGIC_RANDOM);

    if (isHrr) {
      if (hasSeenHrr) {
        return failAlert('unexpected_message');
      }
      /**
       * A HelloRetryRequest may ask for a different group, or for a cookie, or
       * for both — RFC 9846 §4.2.4 requires neither extension on its own. One
       * that asks for NOTHING is the empty retry, and there is nothing the
       * second ClientHello could say differently.
       */
      if (keyShareExt === undefined && cookieExt === undefined) {
        return failAlert('illegal_parameter');
      }
      /**
       * A HelloRetryRequest ends the server's flight — the next thing on the
       * wire is our second ClientHello. Bytes still buffered behind it are the
       * start of a message the server means to finish AFTER our reply, which
       * §5.1 does not allow and which would be spliced onto the real
       * ServerHello when it arrives.
       */
      if (handshakeBuffer.some(chunk => chunk.length > 0)) {
        return failAlert('unexpected_message');
      }
      hasSeenHrr = true;
      hrrSelectedSuite = negotiatedSuite;

      /**
       * RFC 9846 §4.2.4: in the updated ClientHello the client "SHOULD NOT offer
       * any pre-shared keys associated with a hash other than that of the
       * selected cipher suite". Offering one anyway would be worse than
       * pointless — the binder is a MAC under the PSK's own hash, so a server
       * that took it would then key the connection from a schedule the other
       * hash produced.
       */
      if (
        offeredSession !== undefined &&
        CIPHER_SUITES[offeredSession.suite].hash !== CIPHER_SUITES[negotiatedSuite].hash
      ) {
        offeredSession = undefined;
      }

      if (keyShareExt !== undefined) {
        /**
         * RFC 9846 §4.3.8 puts TWO conditions on the retried group, and both are
         * `illegal_parameter`: it must be one we offered in `supported_groups`,
         * and it must NOT be the one we already sent a key share for.
         *
         * The second is what makes a retry a change. Without it a server can
         * bounce us back onto the group we already offered a share on — a round
         * trip that costs us a fresh key and gains the handshake nothing, which
         * §4.2.4 forbids in as many words: abort "if the HelloRetryRequest would
         * not result in any change in the ClientHello".
         */
        const selectedCode = keyShareExt.selectedGroup;
        const selectedGroup =
          selectedCode === undefined ? undefined : namedGroupFromCode(selectedCode);
        if (
          selectedCode === undefined ||
          !offeredGroupCodes.has(selectedCode) ||
          selectedGroup === undefined ||
          selectedGroup === effectiveGroupName
        ) {
          return failAlert('illegal_parameter');
        }
        effectiveGroupName = selectedGroup;
      }

      await transcript.replaceClientHello1WithMessageHash();
      transcript.add(shBytes);

      let ch2MessageBytes: Uint8Array;
      if (replay !== undefined) {
        const ch2 = replay.clientHelloMessages[1];
        const priv2 = replay.clientEphemeralPrivateKeys[1];
        if (ch2 === undefined || priv2 === undefined) {
          throw new Error('Replay missing ClientHello2 or private key for HRR');
        }
        ch2MessageBytes = ch2;
        clientShare = await importPrivateShare(effectiveGroupName, priv2);
      } else {
        // Asked only for a cookie, the second ClientHello carries the SAME key
        // share as the first (§4.2.2). Generating a fresh one would be a
        // different ClientHello than the one the server retried.
        if (keyShareExt !== undefined) {
          clientShare = await generateKeyShare(effectiveGroupName);
        }
        const cookie = cookieExt?.kind === 'cookie' ? cookieExt.cookie : undefined;
        if (cookie !== undefined && cookie.length > MAX_ECHOED_COOKIE_BYTES) {
          return failAlert('illegal_parameter');
        }
        ch2MessageBytes = encodeProductionClientHello({
          serverName,
          keySharePublicKey: clientShare.publicKey,
          group: effectiveGroupName,
          supportedGroups: offeredGroups,
          signatureSchemes: offeredSchemes,
          legacySessionId: sentSessionId,
          random: ch1Random,
          cookie,
          // RFC 9846 §4.2.2 lists what the second ClientHello may change, and
          // this is on it: "Updating the 'pre_shared_key' extension if present by
          // recomputing the 'obfuscated_ticket_age' and binder values". So the
          // clock is read again rather than carried over from the first.
          psk: pskOffer(offeredSession, now()),
        });
        if (offeredSession !== undefined) {
          // §4.3.11.2: the binder covers the transcript, which after a retry is
          // the rebuilt `message_hash` and the HelloRetryRequest ahead of the
          // truncated second ClientHello — both already in the transcript here.
          ch2MessageBytes = await bindClientHello(
            offeredSession,
            ch2MessageBytes,
            transcript.getMessages(),
          );
        }
      }

      /**
       * RFC 9846 D.4: in compatibility mode the client sends one dummy
       * ChangeCipherSpec immediately before its second flight — which is THIS
       * message when the server retried, and the Finished flight otherwise.
       * Sending it only before Finished left a retried handshake without the
       * record the peer was waiting on.
       */
      await sendCompatibilityCcsIfPending();

      transcript.add(ch2MessageBytes);
      for (const record of clientHelloRecords(ch2MessageBytes, LEGACY_RECORD_VERSION.STANDARD)) {
        if (!(await writeToPeer(record))) {
          return { ok: false, reason: { kind: 'truncated' } };
        }
      }
      continue;
    }

    /**
     * RFC 9846 §4.3.11, the server's half of a resumption. Three ways it can be
     * wrong and each is a different sentence of the RFC:
     *
     *  - answering a `pre_shared_key` we did not send is §4.3's response to
     *    nothing, and the retry that drops a PSK is exactly how a ClientHello
     *    that offered one comes to be answered by a ServerHello that may not;
     *  - `selected_identity` is an index into the list we sent, and this client
     *    sends one identity, so 0 is the only value in range;
     *  - the suite has to carry the PSK's own hash, or the connection is keyed
     *    from a schedule the other hash produced.
     */
    const serverPskExt = msg.extensions.find(e => e.kind === 'pre_shared_key');
    if (serverPskExt !== undefined) {
      if (offeredSession === undefined) {
        return failAlert('unsupported_extension');
      }
      if (serverPskExt.kind !== 'pre_shared_key' || serverPskExt.selectedIdentity !== 0) {
        return failAlert('illegal_parameter');
      }
      if (CIPHER_SUITES[offeredSession.suite].hash !== CIPHER_SUITES[selectedSuite].hash) {
        return failAlert('illegal_parameter');
      }
      resumedSession = offeredSession;
    }

    /**
     * A real ServerHello has to carry the share the key exchange runs on, and
     * WHICH alert that earns depends on whether a PSK was selected.
     *
     * §4.3.11 is one sentence with three clauses — `selected_identity` in range,
     * a suite whose Hash matches the PSK, "and that a server `key_share`
     * extension is present if required by the ClientHello
     * `psk_key_exchange_modes` extension. If these values are not consistent,
     * the client MUST abort the handshake with an `illegal_parameter` alert."
     * We offer `psk_dhe_ke` alone, so a selected PSK always requires the share.
     *
     * Without a PSK there is no such sentence and the extension is simply the
     * mandatory one §9.2 is about, which `missing_extension` names.
     */
    if (keyShareExt === undefined) {
      return failAlert(resumedSession !== undefined ? 'illegal_parameter' : 'missing_extension');
    }

    // Real ServerHello
    if (keyShareExt.serverShare === undefined) {
      return failAlert('illegal_parameter');
    }

    // The server's share has to be on the group our current private key is on.
    if (keyShareExt.serverShare.group !== NAMED_GROUPS[effectiveGroupName]) {
      return failAlert('illegal_parameter');
    }

    serverShareKeyExchange = keyShareExt.serverShare.keyExchange;
    realServerHelloBytes = shBytes;
  }

  if (negotiatedSuite === undefined || serverShareKeyExchange === undefined) {
    throw new Error('ServerHello negotiation incomplete');
  }

  /**
   * RFC 9846 §5.1: a handshake message may not span a key change, and the keys
   * change here. Bytes still in the buffer are the start of a message sent in
   * the clear that the server means to finish under the handshake keys — and
   * left alone they would be spliced onto the front of the decrypted flight.
   */
  if (handshakeBuffer.some(chunk => chunk.length > 0)) {
    return failAlert('unexpected_message');
  }

  transcript.add(realServerHelloBytes);

  // Guard peer share length / form before WebCrypto (attacker-controlled → typed failure)
  const shareLen = expectedKeyShareLength(effectiveGroupName);
  if (
    serverShareKeyExchange.length !== shareLen ||
    (effectiveGroupName !== 'x25519' && serverShareKeyExchange[0] !== 0x04)
  ) {
    return failAlert('illegal_parameter');
  }

  let sharedSecret: Uint8Array;
  try {
    sharedSecret = await deriveSharedSecret(
      effectiveGroupName,
      clientShare.privateKey,
      serverShareKeyExchange,
    );
  } catch {
    return failAlert('illegal_parameter');
  }

  // 3. Derive Handshake Keys
  const early = await earlySecret(negotiatedSuite, resumedSession?.preSharedKey);
  const hsSecret = await handshakeSecret(negotiatedSuite, early, sharedSecret);
  const c_hs_traffic = await deriveSecret(
    negotiatedSuite,
    hsSecret,
    'c hs traffic',
    ...transcript.getMessages(),
  );
  const s_hs_traffic = await deriveSecret(
    negotiatedSuite,
    hsSecret,
    's hs traffic',
    ...transcript.getMessages(),
  );

  const clientHsKeys = await trafficKeys(negotiatedSuite, c_hs_traffic);
  const serverHsKeys = await trafficKeys(negotiatedSuite, s_hs_traffic);
  let clientHsSeq = 0n;
  let serverHsSeq = 0n;
  clientWriteKeys = { key: clientHsKeys.key, iv: clientHsKeys.iv, seq: clientHsSeq };

  // 4. Read Encrypted Server Flight (EE, [CR], Cert, CV, Finished)
  let eeReceived = false;
  let certReceived = false;
  let cvReceived = false;
  let finReceived = false;
  let certRequestContext: Uint8Array | null = null;
  let leafDer: Uint8Array | undefined;
  let intermediates: Uint8Array[] = [];
  let cvScheme: SignatureScheme | undefined;
  let cvSignature: Uint8Array | undefined;
  let transcriptHashAtCert: Uint8Array | undefined;
  /**
   * Set by whichever path validation this connection actually performs — the
   * peer's Certificate on a full handshake, the stored chain on a resumed one
   * that re-checks. It stays `null` when neither runs, which is the resumption
   * that trusts what it stored.
   */
  let peerPublicKeyPin: string | null = null;

  let emptyRecordsSeen = 0;

  while (!finReceived) {
    let extracted = extractNextHandshakeMessage();
    while (extracted.kind === 'need-more') {
      const recResult = await reader.readRecord();
      if (!recResult.ok) {
        if (recResult.kind === 'truncated') {
          return { ok: false, reason: { kind: 'truncated' } };
        }
        return failAlert(recResult.description);
      }
      if (recResult.kind === 'eof') {
        return { ok: false, reason: { kind: 'truncated' } };
      }

      const record = recResult.record;
      if (record[0] === 0x14) {
        emptyRecordsSeen += 1;
        if (emptyRecordsSeen > MAX_CONSECUTIVE_EMPTY_RECORDS) {
          return failAlert('unexpected_message');
        }
        continue;
      }

      if (record[0] !== 0x17) {
        return failAlert('unexpected_message');
      }
      emptyRecordsSeen = 0;

      const openRes = await openAead(serverHsKeys.key, serverHsKeys.iv, serverHsSeq, record);
      serverHsSeq += 1n;

      if (!openRes.ok) {
        return failAlert(openRes.description);
      }

      if (openRes.type === 'alert') {
        const alertRes = decodeAlert(openRes.payload);
        if (alertRes.ok) {
          return { ok: false, reason: { kind: 'alert-received', alert: alertRes.alert } };
        }
        if (alertRes.unknownDescriptionCode !== undefined) {
          return {
            ok: false,
            reason: { kind: 'alert-received-unknown', code: alertRes.unknownDescriptionCode },
          };
        }
        // The decoder already knows WHICH way the alert was malformed — a bogus
        // level is an illegal_parameter, a bogus length a decode_error. Flattening
        // both to decode_error threw that away.
        return failAlert(alertRes.description);
      }

      if (openRes.type !== 'handshake') {
        return failAlert('unexpected_message');
      }

      handshakeBuffer.push(openRes.payload);
      extracted = extractNextHandshakeMessage();
    }

    if (extracted.kind === 'overflow') {
      return failAlert('decode_error');
    }

    const nextMsgBytes = extracted.bytes;
    const decoded = decodeHandshakeMessage(nextMsgBytes);
    if (!decoded.ok) {
      return failAlert(decoded.description);
    }

    const msg = decoded.value;

    if (!eeReceived) {
      if (msg.kind !== 'encrypted_extensions') {
        return failAlert('unexpected_message');
      }
      const eeExtensionAlert = misplacedExtensionAlert(
        msg.extensions,
        offeredExtensionCodes,
        PERMITTED_IN_ENCRYPTED_EXTENSIONS,
      );
      if (eeExtensionAlert !== null) {
        return failAlert(eeExtensionAlert);
      }
      eeReceived = true;
      transcript.add(nextMsgBytes);
      continue;
    }

    /**
     * A resumed handshake is authenticated by the PSK, so RFC 9846 §2.2 sends
     * neither Certificate nor CertificateVerify — EncryptedExtensions is
     * followed by Finished and nothing else. Skipping the two branches is what
     * makes a Certificate that arrives anyway an `unexpected_message`.
     *
     * **No chain arrives HERE, which is not the same as no chain being
     * validated.** The one the session stored is re-validated after this loop
     * ends, unless `reverifyOnResume` was turned off — see the check below the
     * `break`.
     */
    if (resumedSession === undefined && !certReceived) {
      if (msg.kind === 'certificate_request') {
        certRequestContext = msg.certificateRequestContext;
        transcript.add(nextMsgBytes);
        continue;
      }

      if (msg.kind !== 'certificate') {
        return failAlert('unexpected_message');
      }

      // RFC 9846 §4.5.1 names the alert: an empty Certificate from the server
      // is a decode_error, not a complaint about a certificate we never got.
      if (msg.certificateList.length === 0) {
        return failAlert('decode_error');
      }

      const firstCert = msg.certificateList[0];
      if (firstCert === undefined) {
        return failAlert('bad_certificate');
      }

      const certificateExtensionAlert = msg.certificateList
        .map(entry =>
          misplacedExtensionAlert(
            entry.extensions,
            offeredExtensionCodes,
            PERMITTED_IN_CERTIFICATE_ENTRY,
          ),
        )
        .find(alert => alert !== null);
      if (certificateExtensionAlert != null) {
        return failAlert(certificateExtensionAlert);
      }

      leafDer = firstCert.certData;
      intermediates = msg.certificateList.slice(1).map(c => c.certData);
      certReceived = true;
      transcript.add(nextMsgBytes);
      transcriptHashAtCert = await transcript.hash();
      continue;
    }

    if (resumedSession === undefined && !cvReceived) {
      if (msg.kind !== 'certificate_verify') {
        return failAlert('unexpected_message');
      }
      cvReceived = true;
      /**
       * RFC 9846 §4.5.2: "If the CertificateVerify message is sent by a server,
       * the signature algorithm MUST be one offered in the client's
       * `signature_algorithms` extension unless no valid certificate chain can
       * be produced without unsupported algorithms".
       *
       * Checked here, on the message, rather than left to `importLeafKey`'s
       * unknown-scheme case: that one answers "we cannot verify this", and it
       * cannot answer "we can verify it but never asked for it" — which is the
       * one that matters, because a scheme the client withheld is a scheme it
       * declined, and honouring it anyway would let a server pick an algorithm
       * out of the set we deliberately shrank.
       *
       * Deliberately AHEAD of `validatePath` below, which is where BoringSSL
       * differs — it validates the chain on the Certificate message, a flight
       * earlier. So a flight that is both signed with an unoffered scheme and
       * carries an untrusted chain reports `illegal_parameter` where BoringSSL
       * would report the certificate. The RFC names no order and no BoGo test
       * pairs the two faults, so this is not a divergence to record: it is a
       * message-level parameter check, and it is cheaper than the path build it
       * would otherwise precede for a signature that can never be accepted.
       */
      const offeredScheme = signatureSchemeFromCode(msg.scheme);
      if (offeredScheme === undefined || !offeredSchemes.includes(offeredScheme)) {
        return failAlert('illegal_parameter');
      }
      cvScheme = offeredScheme;
      cvSignature = msg.signature;

      if (leafDer === undefined) throw new Error('Leaf certificate is undefined');
      const pathRes = await validatePeerChain({
        leafDer,
        intermediateDer: intermediates,
      });

      if (!pathRes.ok) {
        return failValidation(pathRes.reason, 'peer-sent');
      }

      let leafCert: ReturnType<typeof decodeCertificate>;
      try {
        leafCert = decodeCertificate(leafDer);
      } catch {
        return failAlert('bad_certificate');
      }

      if (transcriptHashAtCert === undefined) throw new Error('transcriptHashAtCert undefined');

      const cvVerifyRes = await verifyCertificateVerify({
        scheme: SIGNATURE_SCHEMES[cvScheme],
        signature: cvSignature,
        spkiDer: leafCert.subjectPublicKeyInfo.der,
        algorithmOid: leafCert.subjectPublicKeyInfo.algorithm.oid,
        transcriptHash: transcriptHashAtCert,
      });

      if (!cvVerifyRes.ok) {
        return failAlert(cvVerifyRes.description);
      }

      /**
       * AFTER the signature, not after the path build. The pin names the key
       * that authenticated this peer, and until this line the peer has only
       * sent a chain — which is public, so sending one proves nothing. One
       * message of difference, and it is the message the whole learn/check
       * split is about.
       *
       * From the validated PATH rather than from `leafCert`, which
       * CertificateVerify just ran against. They are the same bytes —
       * `ValidatedPath` carries the leaf's SPKI DER precisely so `tls` need not
       * parse the certificate twice, and `YOZZ_VALIDATOR`'s path,
       * `decodeCertificate`'s field and `exportKey('spki')` were compared
       * directly and agree — and the path is the copy `pinnedValidator`
       * compares, so sourcing the learn from anywhere else could only introduce
       * a way for the two halves to disagree.
       */
      peerPublicKeyPin = await publicKeyPin(pathRes.path.leafSubjectPublicKeyInfoDer);

      transcript.add(nextMsgBytes);
      continue;
    }

    if (!finReceived) {
      if (msg.kind !== 'finished') {
        return failAlert('unexpected_message');
      }
      finReceived = true;

      const sFinKey = await finishedKey(negotiatedSuite, s_hs_traffic);
      const isFinValid = await isVerifyDataValid(
        negotiatedSuite,
        sFinKey,
        await transcript.hash(),
        msg.verifyData,
      );

      if (!isFinValid) {
        return failAlert('decrypt_error');
      }

      transcript.add(nextMsgBytes);

      // The second key change, and the same rule: nothing may follow Finished
      // inside the flight it ends.
      if (handshakeBuffer.some(chunk => chunk.length > 0)) {
        return failAlert('unexpected_message');
      }
      break;
    }
  }

  /**
   * The resumed handshake's certificate check, over the chain the session
   * stored (see `reverifyOnResume`). It runs HERE, one message later than
   * BoringSSL's `state_server_certificate_reverify`, which sits between
   * EncryptedExtensions and the server's Finished (`tls13_client.cc`). Ours
   * waits for that Finished, so the flight is proven to come from the party
   * holding the pre-shared key before we spend a path build on it. BoGo sees
   * the same thing either way — a fatal alert where the client's Finished was
   * due — which is why the placement is a choice rather than a divergence.
   *
   * The alert leaves protected, under the handshake key, and takes the
   * compatibility ChangeCipherSpec with it if one is still owed.
   */
  if (resumedSession !== undefined && (options.reverifyOnResume ?? true)) {
    const reverified = await validatePeerChain(resumedSession.peerCertificateChain);
    if (!reverified.ok) {
      return failValidation(reverified.reason, 'session-stored');
    }
    peerPublicKeyPin = await publicKeyPin(reverified.path.leafSubjectPublicKeyInfoDer);
  }

  // Application Traffic Keys & Master Secret (derived over transcript through server Finished)
  const master = await masterSecret(negotiatedSuite, hsSecret);
  const c_ap_traffic = await deriveSecret(
    negotiatedSuite,
    master,
    'c ap traffic',
    ...transcript.getMessages(),
  );
  const s_ap_traffic = await deriveSecret(
    negotiatedSuite,
    master,
    's ap traffic',
    ...transcript.getMessages(),
  );
  /**
   * RFC 9846 §7.1's `exporter_master_secret`, over ClientHello...server
   * Finished — the SAME transcript as the two traffic secrets above, and one
   * message short of `res master` below. It is derived here and kept because
   * the exporter outlives the handshake and the transcript does not.
   */
  const exporterMaster = await deriveSecret(
    negotiatedSuite,
    master,
    'exp master',
    ...transcript.getMessages(),
  );

  // 5. Send Client Finished Flight
  await sendCompatibilityCcsIfPending();

  if (certRequestContext !== null) {
    const emptyCertMsg = encodeHandshakeMessage({
      kind: 'certificate',
      certificateRequestContext: certRequestContext,
      certificateList: [],
    });
    transcript.add(emptyCertMsg);
    const sealedCertRecord = await sealAead(
      clientHsKeys.key,
      clientHsKeys.iv,
      clientHsSeq,
      'handshake',
      emptyCertMsg,
    );
    clientHsSeq += 1n;
    clientWriteKeys = { key: clientHsKeys.key, iv: clientHsKeys.iv, seq: clientHsSeq };
    if (!(await writeToPeer(sealedCertRecord))) {
      return { ok: false, reason: { kind: 'truncated' } };
    }
  }

  const cFinKey = await finishedKey(negotiatedSuite, c_hs_traffic);
  const clientVerifyData = await verifyData(negotiatedSuite, cFinKey, await transcript.hash());
  const clientFinMsg = encodeHandshakeMessage({ kind: 'finished', verifyData: clientVerifyData });
  transcript.add(clientFinMsg);
  const sealedFinRecord = await sealAead(
    clientHsKeys.key,
    clientHsKeys.iv,
    clientHsSeq,
    'handshake',
    clientFinMsg,
  );
  clientHsSeq += 1n;
  clientWriteKeys = { key: clientHsKeys.key, iv: clientHsKeys.iv, seq: clientHsSeq };
  if (!(await writeToPeer(sealedFinRecord))) {
    return { ok: false, reason: { kind: 'truncated' } };
  }

  /**
   * RFC 9846 §7.1's `resumption_master_secret`. It runs over the transcript
   * through the CLIENT's Finished — one message further than the application
   * traffic secrets above, which is the whole reason it is derived down here
   * rather than beside them. Every ticket the server later sends expands from
   * it, so it outlives the handshake and the transcript does not.
   */
  const resumptionSecret = await deriveSecret(
    negotiatedSuite,
    master,
    'res master',
    ...transcript.getMessages(),
  );

  /**
   * When the peer was proved, by which signature, and over which chain —
   * inherited whole on a resumed handshake, which proves none of the three. The
   * rule and its consequences live in `session.ts` beside the ceiling that
   * reads `authenticatedAt`, because that is the only place any of them can be
   * tested: no peer this package can drive mints a ticket on a resumed
   * connection (see the note where these reach `sessionFromTicket` below).
   */
  const { authenticatedAt, peerSignatureScheme, peerCertificateChain } = inheritedAuthentication(
    resumedSession,
    cvScheme === undefined || leafDer === undefined
      ? undefined
      : {
          authenticatedAt: now(),
          peerSignatureScheme: cvScheme,
          peerCertificateChain: { leafDer, intermediateDer: intermediates },
        },
  );

  let clientTrafficSecret = c_ap_traffic;
  let serverTrafficSecret = s_ap_traffic;
  let clientAppKeys = await trafficKeys(negotiatedSuite, clientTrafficSecret);
  let serverAppKeys = await trafficKeys(negotiatedSuite, serverTrafficSecret);
  let clientAppSeq = 0n;
  let serverAppSeq = 0n;
  /**
   * TLS 1.3 closes each direction on its own (RFC 9846 §6.1): a `close_notify`
   * says the SENDER is done writing, and says nothing about the receiver.
   * Holding one flag for both made the peer's goodbye close our write side —
   * so we never sent ours back, and a peer waiting for it waited forever.
   */
  let peerSentCloseNotify = false;
  let sentCloseNotify = false;
  clientWriteKeys = { key: clientAppKeys.key, iv: clientAppKeys.iv, seq: clientAppSeq };

  let writeQueue: Promise<unknown> = Promise.resolve();
  const queueWrite = <T>(action: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(action, action);
    writeQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const syncClientWriteKeys = (): void => {
    clientWriteKeys = { key: clientAppKeys.key, iv: clientAppKeys.iv, seq: clientAppSeq };
  };

  /**
   * Send the alert, then fail with it. Every established-connection failure goes
   * out through the write queue, because sealing outside it is how one AES-GCM
   * `(key, nonce)` came to cover two plaintexts.
   */
  const abortWith = async (
    description: Alert['description'],
  ): Promise<{ readonly ok: false; readonly reason: TlsFailure }> => {
    await queueWrite(async () => {
      await sendFatalAlert(description);
    });
    return { ok: false, reason: { kind: 'alert-sent', alert: { level: 'fatal', description } } };
  };

  let emptyPostHandshakeRecords = 0;
  let warningAlertsSeen = 0;
  let keyUpdatesSeen = 0;
  let sessionTicketsSeen = 0;

  /**
   * A `KeyUpdate` asking us to update in return is answered ONCE, on the next
   * thing we write — not once per request.
   *
   * RFC 9846 §4.7.3 requires the response but sets no deadline, and a peer can
   * put several requests in flight before any of them is answered. Answering
   * each one turns one cheap record into an unbounded reply stream, and a peer
   * strict about unsolicited KeyUpdates (BoGo is, and so is BoringSSL) drops
   * the connection on the second.
   *
   * Owing it to the WRITE path is also what keeps the key rotation inside the
   * write queue, where every client-write key and sequence mutation has to
   * happen: sealing one outside it is how a single AES-GCM (key, nonce) came to
   * cover two plaintexts once already.
   */
  let keyUpdateResponseOwed = false;

  const payKeyUpdateResponse = async (): Promise<void> => {
    if (!keyUpdateResponseOwed) return;
    keyUpdateResponseOwed = false;

    const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });
    const sealedKu = await sealAead(
      clientAppKeys.key,
      clientAppKeys.iv,
      clientAppSeq,
      'handshake',
      kuMsg,
    );
    clientAppSeq += 1n;
    await transport.write(sealedKu);

    clientTrafficSecret = await hkdfExpandLabel(
      negotiatedSuite,
      clientTrafficSecret,
      'traffic upd',
      new Uint8Array(0),
      CIPHER_SUITES[negotiatedSuite].hashLength,
    );
    clientAppKeys = await trafficKeys(negotiatedSuite, clientTrafficSecret);
    clientAppSeq = 0n;
    syncClientWriteKeys();
  };

  const connection: TlsConnection = {
    read: async (): Promise<TlsReadResult> => {
      while (true) {
        if (peerSentCloseNotify) return { ok: true, kind: 'closed' };
        let extracted = extractNextHandshakeMessage();
        if (extracted.kind === 'message') {
          // Leftover handshake bytes from a prior coalesced record.
        } else if (extracted.kind === 'overflow') {
          return abortWith('decode_error');
        } else {
          const recResult = await reader.readRecord();
          if (!recResult.ok) {
            if (recResult.kind === 'truncated') {
              return { ok: false, reason: { kind: 'truncated' } };
            }
            return abortWith(recResult.description);
          }

          if (recResult.kind === 'eof') {
            return { ok: false, reason: { kind: 'truncated' } };
          }

          const record = recResult.record;
          // RFC 9846 §5: a ChangeCipherSpec is tolerated only until the peer's
          // Finished. The handshake is over, so this one is just a record of the
          // wrong type.
          if (record[0] !== 0x17) {
            return abortWith('unexpected_message');
          }

          const openRes = await openAead(serverAppKeys.key, serverAppKeys.iv, serverAppSeq, record);
          serverAppSeq += 1n;

          if (!openRes.ok) {
            return abortWith(openRes.description);
          }

          if (openRes.type === 'application_data') {
            // Zero-length application records are a legal traffic-analysis
            // countermeasure (§5.4). They are not data, and an endless stream of
            // them is not a conversation.
            if (openRes.payload.length === 0) {
              emptyPostHandshakeRecords += 1;
              if (emptyPostHandshakeRecords > MAX_CONSECUTIVE_EMPTY_RECORDS) {
                return abortWith('unexpected_message');
              }
              continue;
            }
            // A byte of application data is progress, and progress clears all
            // three ceilings.
            emptyPostHandshakeRecords = 0;
            warningAlertsSeen = 0;
            keyUpdatesSeen = 0;
            sessionTicketsSeen = 0;
            return { ok: true, kind: 'data', bytes: openRes.payload };
          }

          if (openRes.type === 'alert') {
            const alertRes = decodeAlert(openRes.payload);
            if (!alertRes.ok) {
              if (alertRes.unknownDescriptionCode !== undefined) {
                return {
                  ok: false,
                  reason: {
                    kind: 'alert-received-unknown',
                    code: alertRes.unknownDescriptionCode,
                  },
                };
              }
              return abortWith(alertRes.description);
            }
            if (alertRes.alert.description === 'close_notify') {
              peerSentCloseNotify = true;
              return { ok: true, kind: 'closed' };
            }
            // §6.1: `user_canceled` says the peer is going away for a reason
            // that is not a protocol failure, so it is ignored — but counted.
            if (alertRes.alert.description === 'user_canceled') {
              warningAlertsSeen += 1;
              if (warningAlertsSeen > MAX_WARNING_ALERTS) {
                return abortWith('unexpected_message');
              }
              continue;
            }
            return { ok: false, reason: { kind: 'alert-received', alert: alertRes.alert } };
          }

          if (openRes.type !== 'handshake') {
            return abortWith('unexpected_message');
          }

          handshakeBuffer.push(openRes.payload);
          extracted = extractNextHandshakeMessage();
          while (extracted.kind === 'need-more') {
            // Need another record to finish this handshake message.
            const more = await reader.readRecord();
            if (!more.ok) {
              if (more.kind === 'truncated') {
                return { ok: false, reason: { kind: 'truncated' } };
              }
              return abortWith(more.description);
            }
            if (more.kind === 'eof') {
              return { ok: false, reason: { kind: 'truncated' } };
            }
            if (more.record[0] !== 0x17) {
              return abortWith('unexpected_message');
            }
            const moreOpen = await openAead(
              serverAppKeys.key,
              serverAppKeys.iv,
              serverAppSeq,
              more.record,
            );
            serverAppSeq += 1n;
            if (!moreOpen.ok) {
              return abortWith(moreOpen.description);
            }
            if (moreOpen.type !== 'handshake') {
              // A non-handshake record mid-fragment is unexpected; put it aside by failing.
              return abortWith('unexpected_message');
            }
            handshakeBuffer.push(moreOpen.payload);
            extracted = extractNextHandshakeMessage();
          }
          if (extracted.kind === 'overflow') {
            return abortWith('decode_error');
          }
        }

        if (extracted.kind !== 'message') {
          continue;
        }

        const decoded = decodeHandshakeMessage(extracted.bytes);
        if (!decoded.ok) {
          return abortWith(decoded.description);
        }

        if (decoded.value.kind === 'new_session_ticket') {
          sessionTicketsSeen += 1;
          if (sessionTicketsSeen > MAX_CONSECUTIVE_SESSION_TICKETS) {
            return abortWith('unexpected_message');
          }
          const { onSession } = options;
          // No listener, no reason to run the derivation the ticket exists for.
          if (onSession !== undefined) {
            const session = await sessionFromTicket({
              serverName,
              expectedPeerName,
              suite: negotiatedSuite,
              resumptionSecret,
              receivedAt: now(),
              authenticatedAt,
              /**
               * These three are what a RENEWAL writes down, and reaching them
               * took the package's first §4 replay through the state machine.
               * No peer this package can DRIVE mints a ticket on a resumed
               * connection: Node's OpenSSL issues two on the full handshake and
               * none on the resumption, BoGo runs all 106 of its resumption
               * tests at `-resume-count 1` so no third connection offers one
               * back, and RFC 8448 §4 publishes no NewSessionTicket.
               *
               * So `session.test.ts` replays §4 and seals §3's ticket under §4's
               * OWN published server application key — which works because the
               * server derives that key over ClientHello..server Finished,
               * before the `EndOfEarlyData` this client never sends. The
               * decryption is the delivery mechanism and the proof of the key
               * schedule at once. Point `inheritedAuthentication` at a fresh
               * authentication and that test fails.
               */
              peerSignatureScheme,
              peerCertificateChain,
              ticket: decoded.value.ticket,
              ticketNonce: decoded.value.ticketNonce,
              ticketAgeAdd: decoded.value.ticketAgeAdd,
              ticketLifetime: decoded.value.ticketLifetime,
            });
            /**
             * The caller's storage is not on the connection's critical path. A
             * ticket is an optimisation — losing one costs a resumption, and
             * letting a `localStorage` quota error out of here would cost the
             * connection AND break `TlsReadResult`, which is total everywhere
             * else in this file.
             */
            if (session !== undefined) {
              try {
                // AWAITED, because the store is a database more often than not
                // and `void | Promise<void>` is what a caller actually writes. A
                // bare call would let an async rejection sail past this catch,
                // which is the failure it exists to stop.
                await onSession(session);
              } catch {
                // The caller could not store it. Nothing here can.
              }
            }
          }
          continue;
        }

        if (decoded.value.kind === 'key_update') {
          keyUpdatesSeen += 1;
          if (keyUpdatesSeen > MAX_KEY_UPDATES) {
            return abortWith('unexpected_message');
          }
          const hashLen = CIPHER_SUITES[negotiatedSuite].hashLength;
          serverTrafficSecret = await hkdfExpandLabel(
            negotiatedSuite,
            serverTrafficSecret,
            'traffic upd',
            new Uint8Array(0),
            hashLen,
          );
          serverAppKeys = await trafficKeys(negotiatedSuite, serverTrafficSecret);
          serverAppSeq = 0n;

          if (decoded.value.requestUpdate) {
            keyUpdateResponseOwed = true;
          }
          continue;
        }

        return abortWith('unexpected_message');
      }
    },

    write: async (plaintext: Uint8Array): Promise<TlsWriteResult> => {
      // Our own close_notify is what ends writing. The peer's does not.
      if (sentCloseNotify) {
        return {
          ok: false,
          reason: {
            kind: 'alert-sent',
            alert: { level: 'warning', description: 'close_notify' },
          },
        };
      }

      const run = async (): Promise<TlsWriteResult> => {
        await payKeyUpdateResponse();
        const hashLen = CIPHER_SUITES[negotiatedSuite].hashLength;
        if (clientAppSeq >= 2n ** 24n) {
          const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });
          const sealedKu = await sealAead(
            clientAppKeys.key,
            clientAppKeys.iv,
            clientAppSeq,
            'handshake',
            kuMsg,
          );
          clientAppSeq += 1n;
          await transport.write(sealedKu);

          clientTrafficSecret = await hkdfExpandLabel(
            negotiatedSuite,
            clientTrafficSecret,
            'traffic upd',
            new Uint8Array(0),
            hashLen,
          );
          clientAppKeys = await trafficKeys(negotiatedSuite, clientTrafficSecret);
          clientAppSeq = 0n;
        }

        // A record carries at most 2^14 bytes of plaintext (§5.1); a larger write is several
        // records, sealed in sequence under the same keys. A mail body is routinely larger.
        for (let offset = 0; offset < plaintext.length; offset += MAX_RECORD_PLAINTEXT) {
          const sealed = await sealAead(
            clientAppKeys.key,
            clientAppKeys.iv,
            clientAppSeq,
            'application_data',
            plaintext.subarray(offset, offset + MAX_RECORD_PLAINTEXT),
          );
          clientAppSeq += 1n;
          syncClientWriteKeys();
          await transport.write(sealed);
        }
        return { ok: true };
      };

      return queueWrite(run);
    },

    close: async (): Promise<TlsCloseResult> => {
      if (sentCloseNotify) return { ok: true };
      sentCloseNotify = true;

      const run = async (): Promise<TlsCloseResult> => {
        await payKeyUpdateResponse();
        const alertPayload = encodeAlert({ level: 'warning', description: 'close_notify' });
        const sealedAlert = await sealAead(
          clientAppKeys.key,
          clientAppKeys.iv,
          clientAppSeq,
          'alert',
          alertPayload,
        );
        clientAppSeq += 1n;
        syncClientWriteKeys();
        try {
          await transport.write(sealedAlert);
          return { ok: true };
        } catch {
          // Transport write failure only — crypto errors above must propagate.
          return { ok: false, reason: { kind: 'truncated' } };
        }
      };

      return queueWrite(run);
    },
    /**
     * Not queued and not stateful — it reads a secret fixed at the end of the
     * handshake and touches no sequence number, so it cannot race a write the
     * way `close` and the KeyUpdate response can.
     */
    exportKeyingMaterial: (label, context, length) =>
      exportKeyingMaterial(negotiatedSuite, exporterMaster, label, context, length),
  };

  return {
    ok: true,
    connection,
    negotiatedGroup: effectiveGroupName,
    isResumed: resumedSession !== undefined,
    isHelloRetryRequested: hasSeenHrr,
    peerSignatureScheme,
    peerPublicKeyPin,
  };
};

export const startTls = (options: StartTlsOptions): Promise<HandshakeResult> =>
  runHandshake(options);
