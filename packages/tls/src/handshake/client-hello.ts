import type { PeerName } from '@yozz.app/x509';
import { decodeHandshakeMessage, encodeProductionClientHello } from '../handshake-messages.ts';
import { CIPHER_SUITES } from '../key-schedule.ts';
import { generateKeyShare, importPrivateShare, type KeySharePair } from '../key-share.ts';
import {
  bindClientHello,
  isSessionOfferable,
  obfuscatedTicketAge,
  type TlsSession,
} from '../session.ts';
import type { Transcript } from '../transcript.ts';
import {
  LEGACY_RECORD_VERSION,
  type NamedGroup,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES,
  TLS_VERSION,
  type Tls12SignatureScheme,
  type TlsProtocolVersion,
} from '../wire.ts';
import {
  clientHelloRecords,
  extensionTypeCode,
  type HandshakeFailure,
  type HandshakePeer,
} from './peer.ts';

export type ReplayClientHelloHooks = {
  readonly clientHelloMessages: readonly Uint8Array[];
  readonly clientEphemeralPrivateKeys: readonly Uint8Array[];
};

/** The caller passes the instant: a retried ClientHello wants a fresh reading (RFC 9846 §4.2.2). */
export const pskOffer = (
  session: TlsSession | undefined,
  now: Temporal.Instant,
): { identity: Uint8Array; obfuscatedTicketAge: number; binderLength: number } | undefined =>
  session === undefined
    ? undefined
    : {
        identity: session.ticket,
        obfuscatedTicketAge: obfuscatedTicketAge(session, now),
        binderLength: CIPHER_SUITES[session.suite].hashLength,
      };

export type SentClientHello = {
  readonly minVersion: TlsProtocolVersion;
  readonly maxVersion: TlsProtocolVersion;
  readonly offeredGroups: readonly NamedGroup[];
  readonly offeredSchemes: readonly Tls12SignatureScheme[];
  readonly offeredExtensionCodes: ReadonlySet<number>;
  readonly offeredGroupCodes: ReadonlySet<number>;
  /** Absent when `maxVersion === 'TLS 1.2'`, since TLS 1.2 sends its share in ClientKeyExchange. */
  readonly clientShare: KeySharePair | undefined;
  readonly effectiveGroupName: NamedGroup;
  readonly sentSessionId: Uint8Array;
  readonly ch1Random: Uint8Array;
  readonly offeredSession: TlsSession | undefined;
};

export const sendClientHello = async ({
  peer,
  transcript,
  serverName,
  expectedPeerName,
  minVersion: minVersionOption,
  maxVersion: maxVersionOption,
  supportedGroups,
  signatureSchemes,
  session,
  now,
  replay,
}: {
  readonly peer: HandshakePeer;
  readonly transcript: Transcript;
  readonly serverName: string;
  readonly expectedPeerName: PeerName | null;
  readonly minVersion?: TlsProtocolVersion;
  readonly maxVersion?: TlsProtocolVersion;
  readonly supportedGroups?: readonly NamedGroup[];
  readonly signatureSchemes?: readonly Tls12SignatureScheme[];
  readonly session?: TlsSession;
  readonly now: () => Temporal.Instant;
  readonly replay?: ReplayClientHelloHooks;
}): Promise<{ readonly ok: true; readonly value: SentClientHello } | HandshakeFailure> => {
  const configuredMinVersion: TlsProtocolVersion = minVersionOption ?? 'TLS 1.2';
  const maxVersion: TlsProtocolVersion = maxVersionOption ?? 'TLS 1.3';
  if (configuredMinVersion === 'TLS 1.3' && maxVersion === 'TLS 1.2') {
    throw new Error('minVersion TLS 1.3 is above maxVersion TLS 1.2');
  }

  // Copied: the list is read again for a retried ClientHello, which RFC 9846 §4.2.4 requires to offer the same.
  const offeredGroups = [...(supportedGroups ?? SUPPORTED_GROUPS)];
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
  const defaultSchemes: readonly Tls12SignatureScheme[] =
    configuredMinVersion === 'TLS 1.2'
      ? SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES
      : SUPPORTED_SIGNATURE_SCHEMES;
  const offeredSchemes = [...(signatureSchemes ?? defaultSchemes)];
  if (offeredSchemes.length === 0) {
    throw new Error('signatureSchemes must offer at least one scheme');
  }
  if (new Set(offeredSchemes).size !== offeredSchemes.length) {
    throw new Error('signatureSchemes must not repeat a scheme');
  }

  const built = await (async () => {
    if (replay !== undefined) {
      const ch1 = replay.clientHelloMessages[0];
      const priv = replay.clientEphemeralPrivateKeys[0];
      if (ch1 === undefined || priv === undefined) {
        throw new Error('Replay missing ClientHello1 or private key');
      }
      // RFC 8448's ClientHello shares x25519.
      const effectiveGroupName: NamedGroup = 'x25519';
      const clientShare = await importPrivateShare(effectiveGroupName, priv);
      const decodedCh1 = decodeHandshakeMessage(ch1);
      if (!decodedCh1.ok || decodedCh1.value.kind !== 'client_hello') {
        throw new Error('Malformed replay ClientHello1');
      }
      // Read the offered floor back off the replayed ClientHello: RFC 8448 offers TLS 1.3 only.
      const versionsExt = decodedCh1.value.extensions.find(e => e.kind === 'supported_versions');
      const replayOffersTls12 =
        versionsExt === undefined ||
        (versionsExt.kind === 'supported_versions' &&
          versionsExt.versions.includes(TLS_VERSION.V1_2));
      const effectiveMinVersion: TlsProtocolVersion =
        minVersionOption ?? (replayOffersTls12 ? 'TLS 1.2' : 'TLS 1.3');
      // A replayed trace can be a resumed one (RFC 8448 §4); gated like production.
      const offeredSession =
        session !== undefined && isSessionOfferable(session, serverName, expectedPeerName, now())
          ? session
          : undefined;
      return {
        minVersion: effectiveMinVersion,
        ch1MessageBytes: ch1,
        clientShare,
        effectiveGroupName,
        sentSessionId: decodedCh1.value.legacySessionId,
        ch1Random: decodedCh1.value.random,
        offeredSession,
      };
    }

    const effectiveGroupName = firstOfferedGroup;
    const ch1Random = crypto.getRandomValues(new Uint8Array(32));

    if (maxVersion === 'TLS 1.2') {
      const sentSessionId = new Uint8Array(0);
      const ch1MessageBytes = encodeProductionClientHello({
        serverName,
        minVersion: configuredMinVersion,
        maxVersion: 'TLS 1.2',
        supportedGroups: offeredGroups,
        signatureSchemes: offeredSchemes,
        legacySessionId: sentSessionId,
        random: ch1Random,
      });
      return {
        minVersion: configuredMinVersion,
        ch1MessageBytes,
        clientShare: undefined,
        effectiveGroupName,
        sentSessionId,
        ch1Random,
        offeredSession: undefined,
      };
    }

    const clientShare = await generateKeyShare(effectiveGroupName);
    const sentSessionId = crypto.getRandomValues(new Uint8Array(32));
    const offeredAt = now();
    const offeredSession =
      session !== undefined && isSessionOfferable(session, serverName, expectedPeerName, offeredAt)
        ? session
        : undefined;
    const rawCh1 = encodeProductionClientHello({
      serverName,
      minVersion: configuredMinVersion,
      maxVersion: 'TLS 1.3',
      keySharePublicKey: clientShare.publicKey,
      group: effectiveGroupName,
      supportedGroups: offeredGroups,
      signatureSchemes: offeredSchemes,
      legacySessionId: sentSessionId,
      random: ch1Random,
      psk: pskOffer(offeredSession, offeredAt),
    });
    const ch1MessageBytes =
      offeredSession !== undefined ? await bindClientHello(offeredSession, rawCh1, []) : rawCh1;
    return {
      minVersion: configuredMinVersion,
      ch1MessageBytes,
      clientShare,
      effectiveGroupName,
      sentSessionId,
      ch1Random,
      offeredSession,
    };
  })();

  // Read back off the ClientHello actually sent: the replay path sends RFC 8448's, whose offers are not ours.
  const [offeredExtensionCodes, offeredGroupCodes] = ((): [
    ReadonlySet<number>,
    ReadonlySet<number>,
  ] => {
    const decoded = decodeHandshakeMessage(built.ch1MessageBytes);
    if (!decoded.ok || decoded.value.kind !== 'client_hello') {
      throw new Error('our own ClientHello does not decode');
    }
    const groups = decoded.value.extensions.find(e => e.kind === 'supported_groups');
    return [
      new Set(decoded.value.extensions.map(extensionTypeCode)),
      new Set(groups?.kind === 'supported_groups' ? groups.groups : []),
    ];
  })();

  peer.setCompatibilityCcsPending(maxVersion === 'TLS 1.3' && built.sentSessionId.length > 0);

  transcript.add(built.ch1MessageBytes);
  for (const record of clientHelloRecords(
    built.ch1MessageBytes,
    LEGACY_RECORD_VERSION.FIRST_CLIENT_HELLO,
  )) {
    if (!(await peer.writeToPeer(record))) {
      return { ok: false, reason: { kind: 'truncated' } };
    }
  }

  return {
    ok: true,
    value: {
      minVersion: built.minVersion,
      maxVersion,
      offeredGroups,
      offeredSchemes,
      offeredExtensionCodes,
      offeredGroupCodes,
      clientShare: built.clientShare,
      effectiveGroupName: built.effectiveGroupName,
      sentSessionId: built.sentSessionId,
      ch1Random: built.ch1Random,
      offeredSession: built.offeredSession,
    },
  };
};
