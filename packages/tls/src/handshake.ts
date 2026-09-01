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
  /** In preference order; the first carries the key share. */
  readonly supportedGroups?: readonly NamedGroup[];
  /** In preference order. RFC 9846 §4.5.2: a CertificateVerify signed with a scheme not offered here is refused. */
  readonly signatureSchemes?: readonly SignatureScheme[];
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
      /** On a resumption, restored from the session. */
      readonly peerSignatureScheme: SignatureScheme;
      /**
       * RFC 7469 pin of the key that authenticated this peer, from the validated path. Only a
       * completed handshake has one: earlier, the peer has only sent a public chain. `null` on a
       * resumption with `reverifyOnResume` off.
       */
      readonly peerPublicKeyPin: string | null;
    }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsConnection = {
  readonly read: () => Promise<TlsReadResult>;
  readonly write: (plaintext: Uint8Array) => Promise<TlsWriteResult>;
  readonly close: () => Promise<TlsCloseResult>;
  /** RFC 9846 §7.5, for channel binding (RFC 9266 `tls-exporter`). `label` may not be empty: `HkdfLabel.label` is `opaque<7..255>`. */
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

/** The uint24 allows 16 MB. BoGo's `LargeMessage` sends a 23 KB chain and expects it to arrive. */
const MAX_HANDSHAKE_MESSAGE_BODY = 65536;

/**
 * TLS 1.3 bounds none of these; the numbers are BoringSSL's, which BoGo pins from both sides. They
 * count CONSECUTIVE occurrences and reset on delivered application data, so a long IMAP session
 * survives its 33rd rekey.
 */
const MAX_CONSECUTIVE_EMPTY_RECORDS = 32;
const MAX_WARNING_ALERTS = 4;
const MAX_KEY_UPDATES = 32;
/** BoGo pins none; each ticket costs an HKDF expansion and a call into the caller's store. Real servers send two. */
const MAX_CONSECUTIVE_SESSION_TICKETS = 32;

/**
 * RFC 9846 §4.3: a response to an offer we never made is `unsupported_extension`; an offered one in
 * a message where it is not defined is `illegal_parameter`. Matched by type code, since every
 * unmodelled extension decodes alike. §4.3's table plus RFC 8449's `record_size_limit`.
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

/** A cookie near its legal maximum makes a ClientHello the uint16 extension block cannot encode. Real cookies are tens of bytes. */
const MAX_ECHOED_COOKIE_BYTES = 16_384;

/** RFC 9846 Table 1 gives HRR its own column: `pre_shared_key` is `CH, SH` only. */
const PERMITTED_IN_HELLO_RETRY_REQUEST = [
  43, // supported_versions
  COOKIE,
  51, // key_share
  // ECH (`CH, HRR, EE`) belongs here the day it is offered.
];

const extensionTypeCode = (extension: Extension): number =>
  extension.kind === 'unknown' ? extension.typeCode : EXTENSION_TYPES[extension.kind];

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

/** The caller passes the instant: a retried ClientHello wants a fresh reading (RFC 9846 §4.2.2). */
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

/** RFC 9846 §5.1 allows fragmenting, and a peer-sized ticket or cookie can overrun one record. */
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

/** Exported for `replay.ts` only, which `index.test.ts` enforces. */
export const runHandshake = async (
  options: StartTlsOptions,
  replay?: InternalReplayHooks,
): Promise<HandshakeResult> => {
  const { transport, serverName } = options;
  const now = options.now ?? (() => new Date());
  const expectedPeerName =
    options.expectedPeerName !== undefined
      ? options.expectedPeerName
      : ({ kind: 'dns', value: serverName } as const);
  // Before a byte goes out, and unconditionally: a session that did not survive the store is the caller's bug.
  if (options.session !== undefined) {
    assertUsableSession(options.session);
  }
  let transcript = new Transcript();
  const reader = new RecordReader(() => transport.read());

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

  let clientWriteKeys: WriteKeys | null = null;

  // RFC 9846 D.4: once, immediately before the second flight, which may be a retried ClientHello,
  // the Finished flight or an early fatal alert.
  let compatibilityCcsPending = false;

  const sendCompatibilityCcsIfPending = async (): Promise<void> => {
    if (!compatibilityCcsPending) return;
    compatibilityCcsPending = false;
    await transport.write(sealPlain('change_cipher_spec', Uint8Array.of(1)));
  };

  // A peer that hangs up mid-handshake is `truncated`, not a thrown error.
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
      // Aborting anyway.
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

  // Both path validations, peer-sent and session-stored, must ask the same question.
  const validatePeerChain = (chain: PeerCertificateChain) =>
    options.validator.validatePath({
      peerCertificateDer: chain.leafDer,
      untrustedIntermediateDer: chain.intermediateDer,
      trustAnchors: options.trustAnchors,
      validationTime: options.validationTime,
      expectedPeerName,
      requiredKeyUsages: ['digitalSignature'],
      // Names, not OIDs: `@yozz.app/x509` looks these up in its own table.
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

  // Copied: the list is read again for a retried ClientHello, which RFC 9846 §4.2.4 requires to offer the same.
  const offeredGroups = [...(options.supportedGroups ?? SUPPORTED_GROUPS)];
  const firstOfferedGroup = offeredGroups[0];
  if (firstOfferedGroup === undefined) {
    throw new Error('supportedGroups must offer at least one group');
  }
  // RFC 9846 §4.3.7: no duplicates. The caller's bug, so it throws.
  if (new Set(offeredGroups).size !== offeredGroups.length) {
    throw new Error('supportedGroups must not repeat a group');
  }

  // Copied and checked like the groups. This stays the caller's list rather than what went on the
  // wire, so a policy narrower than the bytes still binds what we accept.
  const offeredSchemes = [...(options.signatureSchemes ?? SUPPORTED_SIGNATURE_SCHEMES)];
  if (offeredSchemes.length === 0) {
    throw new Error('signatureSchemes must offer at least one scheme');
  }
  if (new Set(offeredSchemes).size !== offeredSchemes.length) {
    throw new Error('signatureSchemes must not repeat a scheme');
  }

  let clientShare: KeySharePair;
  let ch1MessageBytes: Uint8Array;
  let sentSessionId: Uint8Array;
  let ch1Random: Uint8Array;
  /** Reassigned only by a HelloRetryRequest. */
  let effectiveGroupName: NamedGroup;
  /** The session the ClientHello on the wire carries; a HelloRetryRequest onto another hash unsets it. */
  let offeredSession: TlsSession | undefined;

  if (replay !== undefined) {
    const ch1 = replay.clientHelloMessages[0];
    const priv = replay.clientEphemeralPrivateKeys[0];
    if (ch1 === undefined || priv === undefined) {
      throw new Error('Replay missing ClientHello1 or private key');
    }
    ch1MessageBytes = ch1;
    // RFC 8448's ClientHello shares x25519.
    effectiveGroupName = 'x25519';
    clientShare = await importPrivateShare(effectiveGroupName, priv);
    const decodedCh1 = decodeHandshakeMessage(ch1);
    if (!decodedCh1.ok || decodedCh1.value.kind !== 'client_hello') {
      throw new Error('Malformed replay ClientHello1');
    }
    sentSessionId = decodedCh1.value.legacySessionId;
    ch1Random = decodedCh1.value.random;
    // A replayed trace can be a resumed one (RFC 8448 §4); gated like production.
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

  // Read back off the ClientHello actually sent: the replay path sends RFC 8448's, whose offers are not ours.
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

      // A cleartext alert is the server's reason (`protocol_version`, `handshake_failure`): reported, not answered.
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

    // RFC 9846 §4.2.3. legacy_version is checked in the decoder.
    if (msg.legacyCompressionMethod !== 0) {
      return failAlert('illegal_parameter');
    }
    if (!isSameBytes(msg.legacySessionIdEcho, sentSessionId)) {
      return failAlert('illegal_parameter');
    }

    const random = msg.random;
    const randomSuffix = random.subarray(24);
    if (
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_2) ||
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_1)
    ) {
      return failAlert('illegal_parameter');
    }

    // RFC 9846 §4.2.4: after a HelloRetryRequest the selected version must not change, and the alert differs.
    const versionsExt = msg.extensions.find(e => e.kind === 'supported_versions');
    const wrongVersionAlert = hasSeenHrr ? 'illegal_parameter' : 'protocol_version';
    if (versionsExt === undefined || versionsExt.kind !== 'supported_versions') {
      return failAlert(wrongVersionAlert);
    }
    const selectedVersion = versionsExt.versions[0];
    if (selectedVersion !== TLS_VERSION.V1_3) {
      return failAlert(wrongVersionAlert);
    }

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

    // §4.2.4: the suite the HelloRetryRequest selected.
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
      // RFC 9846 §4.2.4: a retry that changes nothing is `illegal_parameter`.
      if (keyShareExt === undefined && cookieExt === undefined) {
        return failAlert('illegal_parameter');
      }
      // An HRR ends the server's flight; bytes buffered behind it would be spliced onto the real ServerHello (§5.1).
      if (handshakeBuffer.some(chunk => chunk.length > 0)) {
        return failAlert('unexpected_message');
      }
      hasSeenHrr = true;
      hrrSelectedSuite = negotiatedSuite;

      // RFC 9846 §4.2.4: no PSK under a hash other than the selected suite's.
      if (
        offeredSession !== undefined &&
        CIPHER_SUITES[offeredSession.suite].hash !== CIPHER_SUITES[negotiatedSuite].hash
      ) {
        offeredSession = undefined;
      }

      if (keyShareExt !== undefined) {
        // RFC 9846 §4.3.8: the retried group must be one we offered and not the one we already shared.
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
        // §4.2.2: a cookie-only retry keeps the same key share.
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
          // §4.2.2: the retried ClientHello recomputes `obfuscated_ticket_age`.
          psk: pskOffer(offeredSession, now()),
        });
        if (offeredSession !== undefined) {
          // §4.3.11.2: the binder covers the rebuilt transcript.
          ch2MessageBytes = await bindClientHello(
            offeredSession,
            ch2MessageBytes,
            transcript.getMessages(),
          );
        }
      }

      // RFC 9846 D.4: the second flight is this message when the server retried.
      await sendCompatibilityCcsIfPending();

      transcript.add(ch2MessageBytes);
      for (const record of clientHelloRecords(ch2MessageBytes, LEGACY_RECORD_VERSION.STANDARD)) {
        if (!(await writeToPeer(record))) {
          return { ok: false, reason: { kind: 'truncated' } };
        }
      }
      continue;
    }

    // RFC 9846 §4.3.11: a PSK answer we did not send is a response to nothing; `selected_identity`
    // must be 0 (one identity offered); the suite must carry the PSK's hash.
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

    // §4.3.11: with a PSK selected a missing share is `illegal_parameter` (only `psk_dhe_ke` is
    // offered); without one it is §9.2's `missing_extension`.
    if (keyShareExt === undefined) {
      return failAlert(resumedSession !== undefined ? 'illegal_parameter' : 'missing_extension');
    }

    if (keyShareExt.serverShare === undefined) {
      return failAlert('illegal_parameter');
    }

    if (keyShareExt.serverShare.group !== NAMED_GROUPS[effectiveGroupName]) {
      return failAlert('illegal_parameter');
    }

    serverShareKeyExchange = keyShareExt.serverShare.keyExchange;
    realServerHelloBytes = shBytes;
  }

  if (negotiatedSuite === undefined || serverShareKeyExchange === undefined) {
    throw new Error('ServerHello negotiation incomplete');
  }

  // RFC 9846 §5.1: a handshake message may not span a key change.
  if (handshakeBuffer.some(chunk => chunk.length > 0)) {
    return failAlert('unexpected_message');
  }

  transcript.add(realServerHelloBytes);

  // Checked before WebCrypto, so a bad share is a typed failure rather than a throw.
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
  /** Set by whichever path validation ran; `null` on a resumption that trusts what it stored. */
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

    // RFC 9846 §2.2: a resumed handshake carries neither Certificate nor CertificateVerify. The
    // stored chain is re-validated after this loop.
    if (resumedSession === undefined && !certReceived) {
      if (msg.kind === 'certificate_request') {
        certRequestContext = msg.certificateRequestContext;
        transcript.add(nextMsgBytes);
        continue;
      }

      if (msg.kind !== 'certificate') {
        return failAlert('unexpected_message');
      }

      // RFC 9846 §4.5.1: an empty Certificate is `decode_error`.
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
      // RFC 9846 §4.5.2: the scheme must be one we offered. Checked before the path build, where
      // BoringSSL validates a flight earlier on the Certificate message.
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

      // After the signature: until now the peer has only sent a public chain. From the validated
      // path, which is the copy `pinnedValidator` compares.
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

      // The second key change: nothing may follow Finished inside its flight.
      if (handshakeBuffer.some(chunk => chunk.length > 0)) {
        return failAlert('unexpected_message');
      }
      break;
    }
  }

  // The stored chain's re-check, after the server's Finished so the flight is proven to come from
  // the PSK holder first (BoringSSL does it a message earlier).
  if (resumedSession !== undefined && (options.reverifyOnResume ?? true)) {
    const reverified = await validatePeerChain(resumedSession.peerCertificateChain);
    if (!reverified.ok) {
      return failValidation(reverified.reason, 'session-stored');
    }
    peerPublicKeyPin = await publicKeyPin(reverified.path.leafSubjectPublicKeyInfoDer);
  }

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
  // RFC 9846 §7.1: over the same transcript as the traffic secrets; kept because the exporter
  // outlives the transcript.
  const exporterMaster = await deriveSecret(
    negotiatedSuite,
    master,
    'exp master',
    ...transcript.getMessages(),
  );

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

  // RFC 9846 §7.1: over the transcript through the client's Finished, one message further than
  // the traffic secrets.
  const resumptionSecret = await deriveSecret(
    negotiatedSuite,
    master,
    'res master',
    ...transcript.getMessages(),
  );

  // Inherited whole on a resumption; see `session.ts`.
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
  // RFC 9846 §6.1: each direction closes on its own.
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

  // Through the write queue, or one AES-GCM (key, nonce) can come to cover two plaintexts.
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

  // RFC 9846 §4.7.3 requires a response but sets no deadline: several requests are answered once,
  // on the next write, inside the write queue.
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
          // RFC 9846 §5: a ChangeCipherSpec is tolerated only until the peer's Finished.
          if (record[0] !== 0x17) {
            return abortWith('unexpected_message');
          }

          const openRes = await openAead(serverAppKeys.key, serverAppKeys.iv, serverAppSeq, record);
          serverAppSeq += 1n;

          if (!openRes.ok) {
            return abortWith(openRes.description);
          }

          if (openRes.type === 'application_data') {
            // §5.4: zero-length records are a traffic-analysis countermeasure, not data.
            if (openRes.payload.length === 0) {
              emptyPostHandshakeRecords += 1;
              if (emptyPostHandshakeRecords > MAX_CONSECUTIVE_EMPTY_RECORDS) {
                return abortWith('unexpected_message');
              }
              continue;
            }
            // Delivered data clears every ceiling.
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
            // §6.1: `user_canceled` is ignored, but counted.
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
              // A non-handshake record mid-fragment.
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
          if (onSession !== undefined) {
            const session = await sessionFromTicket({
              serverName,
              expectedPeerName,
              suite: negotiatedSuite,
              resumptionSecret,
              receivedAt: now(),
              authenticatedAt,
              peerSignatureScheme,
              peerCertificateChain,
              ticket: decoded.value.ticket,
              ticketNonce: decoded.value.ticketNonce,
              ticketAgeAdd: decoded.value.ticketAgeAdd,
              ticketLifetime: decoded.value.ticketLifetime,
            });
            // The caller's store is not on the critical path: a lost ticket costs a resumption.
            if (session !== undefined) {
              try {
                // Awaited, so an async rejection lands in this catch.
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

        // §5.1: at most 2^14 bytes per record.
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
    // Not queued: it reads a fixed secret and touches no sequence number.
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
