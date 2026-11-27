import { decodeAlert } from '../alert.ts';
import { decodeHandshakeMessage, encodeProductionClientHello } from '../handshake-messages.ts';
import { CIPHER_SUITES, type CipherSuite } from '../key-schedule.ts';
import { deriveSharedSecret, generateKeyShare, importPrivateShare } from '../key-share.ts';
import { openPlain } from '../record.ts';
import { bindClientHello, type TlsSession } from '../session.ts';
import { Transcript } from '../transcript.ts';
import {
  DOWNGRADE_SENTINEL_TLS_1_1,
  DOWNGRADE_SENTINEL_TLS_1_2,
  HRR_MAGIC_RANDOM,
  LEGACY_RECORD_VERSION,
  NAMED_GROUPS,
  type NamedGroup,
  namedGroupFromCode,
  TLS_VERSION,
  type Tls12CipherSuite,
  tls12SuiteFromCode,
} from '../wire.ts';
import { pskOffer, type ReplayClientHelloHooks, type SentClientHello } from './client-hello.ts';
import {
  clientHelloRecords,
  expectedKeyShareLength,
  type HandshakeFailure,
  type HandshakePeer,
  isSameBytes,
  MAX_WARNING_ALERTS,
  misplacedExtensionAlert,
} from './peer.ts';

/**
 * RFC 9846 §4.3: a response to an offer we never made is `unsupported_extension`; an offered one in
 * a message where it is not defined is `illegal_parameter`.
 */
const PERMITTED_IN_SERVER_HELLO = [
  41, // pre_shared_key
  43, // supported_versions
  51, // key_share
];

/** Extensions our ClientHello offers that a TLS 1.2 ServerHello may echo. */
const PERMITTED_IN_TLS_1_2_SERVER_HELLO = [
  0, // server_name
  // Tolerated for F5 BigIP TLS 1.2 interop, matching BoringSSL/OpenSSL/NSS; body is ignored.
  10, // supported_groups
  11, // ec_point_formats
  23, // extended_master_secret
  65281, // renegotiation_info
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

const suiteFromCode = (code: number): CipherSuite | undefined => {
  if (code === 0x1301) return 'TLS_AES_128_GCM_SHA256';
  if (code === 0x1302) return 'TLS_AES_256_GCM_SHA384';
  return undefined;
};

const rebindTranscript = (suite: CipherSuite, previous: Transcript): Transcript => {
  const next = new Transcript(suite);
  for (const message of previous.getMessages()) {
    next.add(message);
  }
  return next;
};

export type NegotiatedTls13ServerHello = {
  readonly suite: CipherSuite;
  readonly negotiatedGroup: NamedGroup;
  readonly isHelloRetryRequested: boolean;
  readonly resumedSession: TlsSession | undefined;
  readonly sharedSecret: Uint8Array;
  readonly transcript: Transcript;
};

export type NegotiatedTls12ServerHello = {
  readonly suite: Tls12CipherSuite;
  readonly serverRandom: Uint8Array;
  readonly hasExtendedMasterSecret: boolean;
  readonly transcriptMessages: readonly Uint8Array[];
};

export type NegotiatedServerHello =
  | {
      readonly ok: true;
      readonly version: 'TLS 1.3';
      readonly value: NegotiatedTls13ServerHello;
    }
  | {
      readonly ok: true;
      readonly version: 'TLS 1.2';
      readonly value: NegotiatedTls12ServerHello;
    };

export const receiveServerHello = async ({
  peer,
  initialTranscript,
  clientHello,
  serverName,
  now,
  replay,
}: {
  readonly peer: HandshakePeer;
  readonly initialTranscript: Transcript;
  readonly clientHello: SentClientHello;
  readonly serverName: string;
  readonly now: () => Temporal.Instant;
  readonly replay?: ReplayClientHelloHooks;
}): Promise<NegotiatedServerHello | HandshakeFailure> => {
  let transcript = initialTranscript;
  let clientShare = clientHello.clientShare;
  /** Reassigned only by a HelloRetryRequest. */
  let effectiveGroupName = clientHello.effectiveGroupName;
  /** The session the ClientHello on the wire carries; a HelloRetryRequest onto another hash unsets it. */
  let offeredSession = clientHello.offeredSession;

  let hasSeenHrr = false;
  let warningAlertsSeen = 0;
  let negotiatedSuite: CipherSuite | undefined;
  let hrrSelectedSuite: CipherSuite | undefined;
  let serverShareKeyExchange: Uint8Array | undefined;
  let realServerHelloBytes: Uint8Array | undefined;
  /** The offered session, once the server has said it took it. */
  let resumedSession: TlsSession | undefined;

  while (realServerHelloBytes === undefined) {
    let extracted = peer.extractNextHandshakeMessage();
    while (extracted.kind === 'need-more') {
      const recResult = await peer.reader.readRecord();
      if (!recResult.ok) {
        if (recResult.kind === 'truncated') {
          return { ok: false, reason: { kind: 'truncated' } };
        }
        return peer.failAlert(recResult.description);
      }

      if (recResult.kind === 'eof') {
        return { ok: false, reason: { kind: 'truncated' } };
      }

      const record = recResult.record;
      // Middlebox compatibility ChangeCipherSpec is TLS 1.3 only (RFC 9846 D.4).
      if (record[0] === 0x14 && clientHello.maxVersion === 'TLS 1.3') {
        continue;
      }

      if (record[0] === 0x17) {
        return peer.failAlert('unexpected_message');
      }

      const plainRes = openPlain(record);
      if (!plainRes.ok) {
        return peer.failAlert(plainRes.description);
      }

      // A cleartext alert is the server's reason (`protocol_version`, `handshake_failure`): reported,
      // not answered. Before the version is known (and while TLS 1.2 is still on the table), RFC
      // 5246 §7.2.2 / RFC 6066 §3 allow a server to send a non-fatal warning alert such as
      // `unrecognized_name` before ServerHello.
      if (plainRes.type === 'alert') {
        if (clientHello.minVersion === 'TLS 1.2' && !hasSeenHrr) {
          const alertRes = decodeAlert(plainRes.payload);
          if (
            alertRes.ok &&
            alertRes.alert.level === 'warning' &&
            alertRes.alert.description !== 'close_notify'
          ) {
            warningAlertsSeen += 1;
            if (warningAlertsSeen > MAX_WARNING_ALERTS) {
              return peer.failAlert('unexpected_message');
            }
            continue;
          }
        }
        return peer.failAlertPayload(plainRes.payload);
      }

      // RFC 5246 §6.2.1 / RFC 9846 §5.1: zero-length handshake fragments are forbidden.
      if (plainRes.type !== 'handshake' || plainRes.payload.length === 0) {
        return peer.failAlert('unexpected_message');
      }

      peer.pushHandshakeBytes(plainRes.payload);
      extracted = peer.extractNextHandshakeMessage();
    }

    if (extracted.kind === 'overflow') {
      return peer.failAlert('decode_error');
    }

    const shBytes = extracted.bytes;
    const decoded = decodeHandshakeMessage(shBytes);
    if (!decoded.ok) {
      return peer.failAlert(decoded.description);
    }

    const msg = decoded.value;
    if (msg.kind !== 'server_hello') {
      return peer.failAlert('unexpected_message');
    }

    // legacy_version is checked in the decoder (0x0303 -> protocol_version otherwise).
    if (msg.legacyCompressionMethod !== 0) {
      return peer.failAlert('illegal_parameter');
    }

    const versionsExt = msg.extensions.find(e => e.kind === 'supported_versions');
    const isHrr = isSameBytes(msg.random, HRR_MAGIC_RANDOM);

    // TLS 1.2 candidate: no `supported_versions` extension.
    if (versionsExt === undefined) {
      // RFC 9846 §4.2.3 / §4.2.4: an HRR-magic random requires TLS 1.3 `supported_versions`, and a
      // server cannot drop from a TLS 1.3 HelloRetryRequest to TLS 1.2.
      if (isHrr || hasSeenHrr) {
        return peer.failAlert('illegal_parameter');
      }
      if (clientHello.minVersion === 'TLS 1.3') {
        return peer.failAlert('protocol_version');
      }
      // RFC 9846 §4.2.3: enforce the downgrade sentinel only when TLS 1.3 was offered; a TLS 1.3
      // server talking to a TLS 1.2-only client legitimately writes DOWNGRADE_SENTINEL_TLS_1_2.
      if (clientHello.maxVersion === 'TLS 1.3') {
        const randomSuffix = msg.random.subarray(24);
        if (
          isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_2) ||
          isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_1)
        ) {
          return peer.failAlert('illegal_parameter');
        }
      }
      // RFC 5246 §7.4.1.2: `opaque SessionID<0..32>`.
      if (msg.legacySessionIdEcho.length > 32) {
        return peer.failAlert('decode_error');
      }
      // TLS 1.2 session resumption is unsupported: refuse a server echoing our middlebox-compat ID.
      if (
        clientHello.sentSessionId.length > 0 &&
        isSameBytes(msg.legacySessionIdEcho, clientHello.sentSessionId)
      ) {
        return peer.failAlert('illegal_parameter');
      }

      peer.setCompatibilityCcsPending(false);

      const selectedTls12Suite = tls12SuiteFromCode(msg.cipherSuite);
      if (selectedTls12Suite === undefined) {
        return peer.failAlert('illegal_parameter');
      }

      const tls12ExtensionAlert = misplacedExtensionAlert(
        msg.extensions,
        clientHello.offeredExtensionCodes,
        PERMITTED_IN_TLS_1_2_SERVER_HELLO,
      );
      if (tls12ExtensionAlert !== null) {
        return peer.failAlert(tls12ExtensionAlert);
      }

      const sniExt = msg.extensions.find(e => e.kind === 'server_name');
      if (
        sniExt !== undefined &&
        sniExt.kind === 'server_name' &&
        sniExt.serverNames.length !== 0
      ) {
        return peer.failAlert('decode_error');
      }

      const ecPointFormatsExt = msg.extensions.find(e => e.kind === 'ec_point_formats');
      if (
        ecPointFormatsExt !== undefined &&
        ecPointFormatsExt.kind === 'ec_point_formats' &&
        !ecPointFormatsExt.formats.includes(0)
      ) {
        return peer.failAlert('illegal_parameter');
      }

      // RFC 5746 §3.5: non-empty `renegotiated_connection` on an initial handshake is `handshake_failure`.
      const renegExt = msg.extensions.find(e => e.kind === 'renegotiation_info');
      if (
        renegExt !== undefined &&
        renegExt.kind === 'renegotiation_info' &&
        renegExt.renegotiatedConnection.length !== 0
      ) {
        return peer.failAlert('handshake_failure');
      }

      const hasExtendedMasterSecret = msg.extensions.some(e => e.kind === 'extended_master_secret');

      // TLS 1.2 servers routinely coalesce ServerHello + Certificate + SKE + SHD into one record,
      // so buffered handshake bytes stay in the buffer for the TLS 1.2 flight.
      return {
        ok: true,
        version: 'TLS 1.2',
        value: {
          suite: selectedTls12Suite,
          serverRandom: msg.random,
          hasExtendedMasterSecret,
          transcriptMessages: [...transcript.getMessages(), shBytes],
        },
      };
    }

    // `supported_versions` was present: we only offered it when TLS 1.3 was enabled.
    if (clientHello.maxVersion !== 'TLS 1.3') {
      return peer.failAlert('unsupported_extension');
    }

    // RFC 9846 §4.2.1: if `supported_versions` in ServerHello carries a version not offered or a
    // version prior to TLS 1.3 (and §4.2.4 after HRR), abort with `illegal_parameter`.
    if (versionsExt.kind !== 'supported_versions' || versionsExt.versions[0] !== TLS_VERSION.V1_3) {
      return peer.failAlert('illegal_parameter');
    }

    if (!isSameBytes(msg.legacySessionIdEcho, clientHello.sentSessionId)) {
      return peer.failAlert('illegal_parameter');
    }

    const randomSuffix = msg.random.subarray(24);
    if (
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_2) ||
      isSameBytes(randomSuffix, DOWNGRADE_SENTINEL_TLS_1_1)
    ) {
      return peer.failAlert('illegal_parameter');
    }

    const serverHelloExtensionAlert = misplacedExtensionAlert(
      msg.extensions,
      // The cookie is the server's own, so it counts as offered.
      new Set([...clientHello.offeredExtensionCodes, COOKIE]),
      isHrr ? PERMITTED_IN_HELLO_RETRY_REQUEST : PERMITTED_IN_SERVER_HELLO,
    );
    if (serverHelloExtensionAlert !== null) {
      return peer.failAlert(serverHelloExtensionAlert);
    }

    const selectedSuite = suiteFromCode(msg.cipherSuite);
    if (selectedSuite === undefined) {
      return peer.failAlert('illegal_parameter');
    }

    // §4.2.4: the suite the HelloRetryRequest selected.
    if (hrrSelectedSuite !== undefined && selectedSuite !== hrrSelectedSuite) {
      return peer.failAlert('illegal_parameter');
    }

    negotiatedSuite = selectedSuite;
    transcript = rebindTranscript(negotiatedSuite, transcript);

    const keyShareExt = msg.extensions.find(e => e.kind === 'key_share');
    const cookieExt = msg.extensions.find(e => e.kind === 'cookie');

    if (isHrr) {
      if (hasSeenHrr) {
        return peer.failAlert('unexpected_message');
      }
      // RFC 9846 §4.2.4: a retry that changes nothing is `illegal_parameter`.
      if (keyShareExt === undefined && cookieExt === undefined) {
        return peer.failAlert('illegal_parameter');
      }
      // An HRR ends the server's flight; bytes buffered behind it would be spliced onto the real ServerHello (§5.1).
      if (peer.hasBufferedHandshakeBytes()) {
        return peer.failAlert('unexpected_message');
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
          !clientHello.offeredGroupCodes.has(selectedCode) ||
          selectedGroup === undefined ||
          selectedGroup === effectiveGroupName
        ) {
          return peer.failAlert('illegal_parameter');
        }
        effectiveGroupName = selectedGroup;
      }

      await transcript.replaceClientHello1WithMessageHash();
      transcript.add(shBytes);

      const ch2MessageBytes = await (async (): Promise<Uint8Array | HandshakeFailure> => {
        if (replay !== undefined) {
          const ch2 = replay.clientHelloMessages[1];
          const priv2 = replay.clientEphemeralPrivateKeys[1];
          if (ch2 === undefined || priv2 === undefined) {
            throw new Error('Replay missing ClientHello2 or private key for HRR');
          }
          clientShare = await importPrivateShare(effectiveGroupName, priv2);
          return ch2;
        }
        // §4.2.2: a cookie-only retry keeps the same key share.
        if (keyShareExt !== undefined) {
          clientShare = await generateKeyShare(effectiveGroupName);
        }
        if (clientShare === undefined) {
          throw new Error('TLS 1.3 ClientHello2 missing key share');
        }
        const cookie = cookieExt?.kind === 'cookie' ? cookieExt.cookie : undefined;
        if (cookie !== undefined && cookie.length > MAX_ECHOED_COOKIE_BYTES) {
          return peer.failAlert('illegal_parameter');
        }
        const rawCh2 = encodeProductionClientHello({
          serverName,
          minVersion: clientHello.minVersion,
          maxVersion: 'TLS 1.3',
          keySharePublicKey: clientShare.publicKey,
          group: effectiveGroupName,
          supportedGroups: clientHello.offeredGroups,
          signatureSchemes: clientHello.offeredSchemes,
          legacySessionId: clientHello.sentSessionId,
          random: clientHello.ch1Random,
          cookie,
          // §4.2.2: the retried ClientHello recomputes `obfuscated_ticket_age`.
          psk: pskOffer(offeredSession, now()),
        });
        if (offeredSession === undefined) return rawCh2;
        // §4.3.11.2: the binder covers the rebuilt transcript.
        return bindClientHello(offeredSession, rawCh2, transcript.getMessages());
      })();
      if (!(ch2MessageBytes instanceof Uint8Array)) {
        return ch2MessageBytes;
      }

      // RFC 9846 D.4: the second flight is this message when the server retried.
      await peer.sendCompatibilityCcsIfPending();

      transcript.add(ch2MessageBytes);
      for (const record of clientHelloRecords(ch2MessageBytes, LEGACY_RECORD_VERSION.STANDARD)) {
        if (!(await peer.writeToPeer(record))) {
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
        return peer.failAlert('unsupported_extension');
      }
      if (serverPskExt.kind !== 'pre_shared_key' || serverPskExt.selectedIdentity !== 0) {
        return peer.failAlert('illegal_parameter');
      }
      if (CIPHER_SUITES[offeredSession.suite].hash !== CIPHER_SUITES[selectedSuite].hash) {
        return peer.failAlert('illegal_parameter');
      }
      resumedSession = offeredSession;
    }

    // §4.3.11: with a PSK selected a missing share is `illegal_parameter` (only `psk_dhe_ke` is
    // offered); without one it is §9.2's `missing_extension`.
    if (keyShareExt === undefined) {
      return peer.failAlert(
        resumedSession !== undefined ? 'illegal_parameter' : 'missing_extension',
      );
    }

    if (keyShareExt.serverShare === undefined) {
      return peer.failAlert('illegal_parameter');
    }

    if (keyShareExt.serverShare.group !== NAMED_GROUPS[effectiveGroupName]) {
      return peer.failAlert('illegal_parameter');
    }

    serverShareKeyExchange = keyShareExt.serverShare.keyExchange;
    realServerHelloBytes = shBytes;
  }

  if (
    negotiatedSuite === undefined ||
    serverShareKeyExchange === undefined ||
    clientShare === undefined
  ) {
    throw new Error('ServerHello negotiation incomplete');
  }

  // RFC 9846 §5.1: a handshake message may not span a key change.
  if (peer.hasBufferedHandshakeBytes()) {
    return peer.failAlert('unexpected_message');
  }

  transcript.add(realServerHelloBytes);

  // Checked before WebCrypto, so a bad share is a typed failure rather than a throw.
  const shareLen = expectedKeyShareLength(effectiveGroupName);
  if (
    serverShareKeyExchange.length !== shareLen ||
    (effectiveGroupName !== 'x25519' && serverShareKeyExchange[0] !== 0x04)
  ) {
    return peer.failAlert('illegal_parameter');
  }

  const sharedSecret = await (async () => {
    try {
      return await deriveSharedSecret(
        effectiveGroupName,
        clientShare.privateKey,
        serverShareKeyExchange,
      );
    } catch {
      return undefined;
    }
  })();
  if (sharedSecret === undefined) {
    return peer.failAlert('illegal_parameter');
  }

  return {
    ok: true,
    version: 'TLS 1.3',
    value: {
      suite: negotiatedSuite,
      negotiatedGroup: effectiveGroupName,
      isHelloRetryRequested: hasSeenHrr,
      resumedSession,
      sharedSecret,
      transcript,
    },
  };
};
