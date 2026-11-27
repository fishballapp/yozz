import { decodeCertificate } from '@yozz.app/x509';
import { decodeHandshakeMessage, encodeHandshakeMessage } from '../handshake-messages.ts';
import {
  type CipherSuite,
  deriveSecret,
  earlySecret,
  finishedKey,
  handshakeSecret,
  isVerifyDataValid,
  masterSecret,
  trafficKeys,
  verifyData,
} from '../key-schedule.ts';
import { publicKeyPin } from '../pinning.ts';
import { openAead, sealAead } from '../record.ts';
import { inheritedAuthentication, type PeerCertificateChain, type TlsSession } from '../session.ts';
import type { Transcript } from '../transcript.ts';
import { verifyCertificateVerify } from '../verify.ts';
import {
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  signatureSchemeFromCode,
  type Tls12SignatureScheme,
} from '../wire.ts';
import {
  createAeadSealer,
  type HandshakeFailure,
  type HandshakePeer,
  misplacedExtensionAlert,
} from './peer.ts';

/** BoringSSL's consecutive-empty-record ceiling, pinned by BoGo. */
const MAX_CONSECUTIVE_EMPTY_RECORDS = 32;

/** RFC 9846 §4.3's table plus RFC 8449's `record_size_limit`. */
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

type Expecting =
  | 'encrypted_extensions'
  | 'certificate_or_request'
  | 'certificate_verify'
  | 'finished';

export type CompletedTls13Flight = {
  readonly clientAppTrafficSecret: Uint8Array;
  readonly serverAppTrafficSecret: Uint8Array;
  readonly exporterMaster: Uint8Array;
  readonly resumptionSecret: Uint8Array;
  readonly authenticatedAt: Temporal.Instant;
  readonly peerSignatureScheme: SignatureScheme;
  readonly peerCertificateChain: PeerCertificateChain;
  readonly peerPublicKeyPin: string | null;
};

export const completeTls13Flight = async ({
  peer,
  transcript,
  suite,
  sharedSecret,
  resumedSession,
  offeredExtensionCodes,
  offeredSchemes,
  reverifyOnResume,
  now,
}: {
  readonly peer: HandshakePeer;
  readonly transcript: Transcript;
  readonly suite: CipherSuite;
  readonly sharedSecret: Uint8Array;
  readonly resumedSession: TlsSession | undefined;
  readonly offeredExtensionCodes: ReadonlySet<number>;
  readonly offeredSchemes: readonly Tls12SignatureScheme[];
  readonly reverifyOnResume: boolean;
  readonly now: () => Temporal.Instant;
}): Promise<{ readonly ok: true; readonly value: CompletedTls13Flight } | HandshakeFailure> => {
  const early = await earlySecret(suite, resumedSession?.preSharedKey);
  const hsSecret = await handshakeSecret(suite, early, sharedSecret);
  const cHsTraffic = await deriveSecret(
    suite,
    hsSecret,
    'c hs traffic',
    ...transcript.getMessages(),
  );
  const sHsTraffic = await deriveSecret(
    suite,
    hsSecret,
    's hs traffic',
    ...transcript.getMessages(),
  );

  const clientHsKeys = await trafficKeys(suite, cHsTraffic);
  const serverHsKeys = await trafficKeys(suite, sHsTraffic);
  let clientHsSeq = 0n;
  let serverHsSeq = 0n;

  peer.setRecordSealer(
    createAeadSealer(
      () => ({ key: clientHsKeys.key, iv: clientHsKeys.iv, seq: clientHsSeq }),
      () => {
        clientHsSeq += 1n;
      },
      () => peer.sendCompatibilityCcsIfPending(),
    ),
  );

  let expecting: Expecting = 'encrypted_extensions';
  let certRequestContext: Uint8Array | null = null;
  let leafDer: Uint8Array | undefined;
  let intermediates: Uint8Array[] = [];
  let cvScheme: SignatureScheme | undefined;
  let transcriptHashAtCert: Uint8Array | undefined;
  /** Set by whichever path validation ran; `null` on a resumption that trusts what it stored. */
  let peerPublicKeyPin: string | null = null;
  let emptyRecordsSeen = 0;

  while (true) {
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
      if (record[0] === 0x14) {
        emptyRecordsSeen += 1;
        if (emptyRecordsSeen > MAX_CONSECUTIVE_EMPTY_RECORDS) {
          return peer.failAlert('unexpected_message');
        }
        continue;
      }

      if (record[0] !== 0x17) {
        return peer.failAlert('unexpected_message');
      }
      emptyRecordsSeen = 0;

      const openRes = await openAead(serverHsKeys.key, serverHsKeys.iv, serverHsSeq, record);
      serverHsSeq += 1n;

      if (!openRes.ok) {
        return peer.failAlert(openRes.description);
      }

      if (openRes.type === 'alert') {
        return peer.failAlertPayload(openRes.payload);
      }

      if (openRes.type !== 'handshake') {
        return peer.failAlert('unexpected_message');
      }

      peer.pushHandshakeBytes(openRes.payload);
      extracted = peer.extractNextHandshakeMessage();
    }

    if (extracted.kind === 'overflow') {
      return peer.failAlert('decode_error');
    }

    const nextMsgBytes = extracted.bytes;
    const decoded = decodeHandshakeMessage(nextMsgBytes);
    if (!decoded.ok) {
      return peer.failAlert(decoded.description);
    }

    const msg = decoded.value;

    if (expecting === 'encrypted_extensions') {
      if (msg.kind !== 'encrypted_extensions') {
        return peer.failAlert('unexpected_message');
      }
      const eeExtensionAlert = misplacedExtensionAlert(
        msg.extensions,
        offeredExtensionCodes,
        PERMITTED_IN_ENCRYPTED_EXTENSIONS,
      );
      if (eeExtensionAlert !== null) {
        return peer.failAlert(eeExtensionAlert);
      }
      transcript.add(nextMsgBytes);
      // RFC 9846 §2.2: a resumed handshake carries neither Certificate nor CertificateVerify.
      expecting = resumedSession === undefined ? 'certificate_or_request' : 'finished';
      continue;
    }

    if (expecting === 'certificate_or_request') {
      if (msg.kind === 'certificate_request') {
        certRequestContext = msg.certificateRequestContext;
        transcript.add(nextMsgBytes);
        continue;
      }

      if (msg.kind !== 'certificate') {
        return peer.failAlert('unexpected_message');
      }

      // RFC 9846 §4.5.1: an empty Certificate is `decode_error`.
      if (msg.certificateList.length === 0) {
        return peer.failAlert('decode_error');
      }

      const firstCert = msg.certificateList[0];
      if (firstCert === undefined) {
        return peer.failAlert('bad_certificate');
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
        return peer.failAlert(certificateExtensionAlert);
      }

      leafDer = firstCert.certData;
      intermediates = msg.certificateList.slice(1).map(c => c.certData);
      transcript.add(nextMsgBytes);
      transcriptHashAtCert = await transcript.hash();
      expecting = 'certificate_verify';
      continue;
    }

    if (expecting === 'certificate_verify') {
      if (msg.kind !== 'certificate_verify') {
        return peer.failAlert('unexpected_message');
      }
      // RFC 9846 §4.5.2: the scheme must be one we offered. Checked before the path build, where
      // BoringSSL validates a flight earlier on the Certificate message.
      const offeredScheme = signatureSchemeFromCode(msg.scheme);
      if (offeredScheme === undefined || !offeredSchemes.includes(offeredScheme)) {
        return peer.failAlert('illegal_parameter');
      }
      cvScheme = offeredScheme;

      if (leafDer === undefined) throw new Error('Leaf certificate is undefined');
      const pathRes = await peer.validatePeerChain({
        leafDer,
        intermediateDer: intermediates,
      });
      if (!pathRes.ok) {
        return peer.failValidation(pathRes.reason, 'peer-sent');
      }

      const leafCert = (() => {
        try {
          return decodeCertificate(leafDer);
        } catch {
          return undefined;
        }
      })();
      if (leafCert === undefined) {
        return peer.failAlert('bad_certificate');
      }

      if (transcriptHashAtCert === undefined) throw new Error('transcriptHashAtCert undefined');

      const cvVerifyRes = await verifyCertificateVerify({
        scheme: SIGNATURE_SCHEMES[cvScheme],
        signature: msg.signature,
        spkiDer: leafCert.subjectPublicKeyInfo.der,
        algorithmOid: leafCert.subjectPublicKeyInfo.algorithm.oid,
        transcriptHash: transcriptHashAtCert,
      });
      if (!cvVerifyRes.ok) {
        return peer.failAlert(cvVerifyRes.description);
      }

      // After the signature: until now the peer has only sent a public chain. From the validated
      // path, which is the copy `pinnedValidator` compares.
      peerPublicKeyPin = await publicKeyPin(pathRes.path.leafSubjectPublicKeyInfoDer);

      transcript.add(nextMsgBytes);
      expecting = 'finished';
      continue;
    }

    if (msg.kind !== 'finished') {
      return peer.failAlert('unexpected_message');
    }

    const sFinKey = await finishedKey(suite, sHsTraffic);
    const isFinValid = await isVerifyDataValid(
      suite,
      sFinKey,
      await transcript.hash(),
      msg.verifyData,
    );
    if (!isFinValid) {
      return peer.failAlert('decrypt_error');
    }

    transcript.add(nextMsgBytes);

    // The second key change: nothing may follow Finished inside its flight.
    if (peer.hasBufferedHandshakeBytes()) {
      return peer.failAlert('unexpected_message');
    }
    break;
  }

  // The stored chain's re-check, after the server's Finished so the flight is proven to come from
  // the PSK holder first (BoringSSL does it a message earlier).
  if (resumedSession !== undefined && reverifyOnResume) {
    const reverified = await peer.validatePeerChain(resumedSession.peerCertificateChain);
    if (!reverified.ok) {
      return peer.failValidation(reverified.reason, 'session-stored');
    }
    peerPublicKeyPin = await publicKeyPin(reverified.path.leafSubjectPublicKeyInfoDer);
  }

  const master = await masterSecret(suite, hsSecret);
  const clientAppTrafficSecret = await deriveSecret(
    suite,
    master,
    'c ap traffic',
    ...transcript.getMessages(),
  );
  const serverAppTrafficSecret = await deriveSecret(
    suite,
    master,
    's ap traffic',
    ...transcript.getMessages(),
  );
  // RFC 9846 §7.1: over the same transcript as the traffic secrets; kept because the exporter
  // outlives the transcript.
  const exporterMaster = await deriveSecret(
    suite,
    master,
    'exp master',
    ...transcript.getMessages(),
  );

  await peer.sendCompatibilityCcsIfPending();

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
    if (!(await peer.writeToPeer(sealedCertRecord))) {
      return { ok: false, reason: { kind: 'truncated' } };
    }
  }

  const cFinKey = await finishedKey(suite, cHsTraffic);
  const clientVerifyData = await verifyData(suite, cFinKey, await transcript.hash());
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
  if (!(await peer.writeToPeer(sealedFinRecord))) {
    return { ok: false, reason: { kind: 'truncated' } };
  }

  // RFC 9846 §7.1: over the transcript through the client's Finished, one message further than
  // the traffic secrets.
  const resumptionSecret = await deriveSecret(
    suite,
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

  return {
    ok: true,
    value: {
      clientAppTrafficSecret,
      serverAppTrafficSecret,
      exporterMaster,
      resumptionSecret,
      authenticatedAt,
      peerSignatureScheme,
      peerCertificateChain,
      peerPublicKeyPin,
    },
  };
};
