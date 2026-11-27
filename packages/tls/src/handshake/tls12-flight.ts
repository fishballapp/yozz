import { decodeCertificate } from '@yozz.app/x509';
import { decodeAlert } from '../alert.ts';
import { decodeTls12HandshakeMessage, encodeTls12HandshakeMessage } from '../handshake-messages.ts';
import { deriveSharedSecret, generateKeyShare } from '../key-share.ts';
import { publicKeyPin } from '../pinning.ts';
import { openPlain, openTls12Aead, sealPlain, sealTls12Aead } from '../record.ts';
import {
  isTls12VerifyDataValid,
  type Tls12KeyBlock,
  tls12ExtendedMasterSecret,
  tls12KeyBlock,
  tls12MasterSecret,
  tls12TranscriptHash,
  tls12VerifyData,
} from '../tls12-key-schedule.ts';
import { spkiEcNamedGroup, verifyServerKeyExchange } from '../verify.ts';
import {
  HANDSHAKE_TYPES,
  NAMED_GROUPS,
  type NamedGroup,
  namedGroupFromCode,
  TLS_1_2_CIPHER_SUITES,
  type Tls12CipherSuite,
  type Tls12SignatureScheme,
  tls12SignatureSchemeFromCode,
} from '../wire.ts';
import {
  createTls12AeadSealer,
  expectedKeyShareLength,
  type HandshakeFailure,
  type HandshakePeer,
  MAX_WARNING_ALERTS,
} from './peer.ts';

const RSA_ENCRYPTION_OID = '1.2.840.113549.1.1.1';
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const ED25519_OID = '1.3.101.112';

type Expecting =
  | 'certificate'
  | 'server_key_exchange'
  | 'cert_request_or_done'
  | 'server_hello_done';

export type CompletedTls12Flight = {
  readonly suite: Tls12CipherSuite;
  readonly negotiatedGroup: NamedGroup;
  readonly peerSignatureScheme: Tls12SignatureScheme;
  readonly peerPublicKeyPin: string;
  readonly masterSecret: Uint8Array<ArrayBuffer>;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly keys: Tls12KeyBlock;
  readonly clientWriteSeq: bigint;
  readonly serverReadSeq: bigint;
};

export const completeTls12Flight = async ({
  peer,
  suite,
  clientRandom,
  serverRandom,
  hasExtendedMasterSecret,
  transcriptMessages,
  offeredGroupCodes,
  offeredSchemes,
}: {
  readonly peer: HandshakePeer;
  readonly suite: Tls12CipherSuite;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly hasExtendedMasterSecret: boolean;
  readonly transcriptMessages: readonly Uint8Array[];
  readonly offeredGroupCodes: ReadonlySet<number>;
  readonly offeredSchemes: readonly Tls12SignatureScheme[];
}): Promise<{ readonly ok: true; readonly value: CompletedTls12Flight } | HandshakeFailure> => {
  const messages: Uint8Array[] = [...transcriptMessages];
  let warningAlertsSeen = 0;

  /** RFC 5246 §7.2.2: non-`close_notify` warning alerts are non-fatal in TLS 1.2, bounded by `MAX_WARNING_ALERTS`. */
  const classifyAlert = (payload: Uint8Array): 'ignore' | 'too-many' | 'abort' => {
    const alertRes = decodeAlert(payload);
    if (
      alertRes.ok &&
      alertRes.alert.level === 'warning' &&
      alertRes.alert.description !== 'close_notify'
    ) {
      warningAlertsSeen += 1;
      return warningAlertsSeen > MAX_WARNING_ALERTS ? 'too-many' : 'ignore';
    }
    return 'abort';
  };

  const readPlainHandshakeMessage = async (): Promise<
    { readonly ok: true; readonly bytes: Uint8Array } | HandshakeFailure
  > => {
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

      const plainRes = openPlain(recResult.record);
      if (!plainRes.ok) {
        return peer.failAlert(plainRes.description);
      }
      if (plainRes.type === 'alert') {
        const verdict = classifyAlert(plainRes.payload);
        if (verdict === 'ignore') continue;
        if (verdict === 'too-many') return peer.failAlert('unexpected_message');
        return peer.failAlertPayload(plainRes.payload);
      }
      // RFC 5246 §6.2.1: zero-length handshake fragments and non-handshake records before SHD are forbidden.
      if (plainRes.type !== 'handshake' || plainRes.payload.length === 0) {
        return peer.failAlert('unexpected_message');
      }

      peer.pushHandshakeBytes(plainRes.payload);
      extracted = peer.extractNextHandshakeMessage();
    }

    if (extracted.kind === 'overflow') {
      return peer.failAlert('decode_error');
    }
    return { ok: true, bytes: extracted.bytes };
  };

  let expecting: Expecting = 'certificate';
  let leafCert: ReturnType<typeof decodeCertificate> | undefined;
  let validatedSpkiDer: Uint8Array | undefined;
  let negotiatedGroup: NamedGroup | undefined;
  let serverPublicKey: Uint8Array | undefined;
  let peerSignatureScheme: Tls12SignatureScheme | undefined;
  let peerPublicKeyPin: string | undefined;
  let wasCertificateRequested = false;

  while (true) {
    const nextRes = await readPlainHandshakeMessage();
    if (!nextRes.ok) return nextRes;
    const msgBytes = nextRes.bytes;

    // Check the handshake type against the state machine BEFORE decoding the body, so a malformed
    // wrong-type message (e.g. an unsigned ServerKeyExchange sent in place of Certificate) raises
    // `unexpected_message` rather than `decode_error`.
    const msgType = msgBytes[0];
    const isExpectedType = (() => {
      if (expecting === 'certificate') return msgType === HANDSHAKE_TYPES.certificate;
      if (expecting === 'server_key_exchange') {
        return msgType === HANDSHAKE_TYPES.server_key_exchange;
      }
      if (expecting === 'cert_request_or_done') {
        return (
          msgType === HANDSHAKE_TYPES.certificate_request ||
          msgType === HANDSHAKE_TYPES.server_hello_done
        );
      }
      return msgType === HANDSHAKE_TYPES.server_hello_done;
    })();
    if (!isExpectedType) {
      return peer.failAlert('unexpected_message');
    }

    const decoded = decodeTls12HandshakeMessage(msgBytes);
    if (!decoded.ok) {
      return peer.failAlert(decoded.description);
    }
    const msg = decoded.value;

    if (expecting === 'certificate') {
      if (msg.kind !== 'certificate') {
        return peer.failAlert('unexpected_message');
      }
      const leafDer = msg.certificateList[0];
      if (leafDer === undefined) {
        return peer.failAlert('decode_error');
      }

      const pathRes = await peer.validatePeerChain({
        leafDer,
        intermediateDer: msg.certificateList.slice(1),
      });
      if (!pathRes.ok) {
        return peer.failValidation(pathRes.reason, 'peer-sent');
      }

      const decodedLeaf = (() => {
        try {
          return decodeCertificate(leafDer);
        } catch {
          return undefined;
        }
      })();
      if (decodedLeaf === undefined) {
        return peer.failAlert('bad_certificate');
      }

      const leafOid = decodedLeaf.subjectPublicKeyInfo.algorithm.oid;
      const expectedAuth = TLS_1_2_CIPHER_SUITES[suite].auth;
      // RFC 8422 §5.1.1: Ed25519 authenticates under the ECDSA cipher suites.
      const isKeyAuthMatch =
        expectedAuth === 'rsa'
          ? leafOid === RSA_ENCRYPTION_OID
          : leafOid === EC_PUBLIC_KEY_OID || leafOid === ED25519_OID;
      if (!isKeyAuthMatch) {
        return peer.failAlert('illegal_parameter');
      }

      // RFC 8422 §5.1.1 / §5.3: under TLS 1.2, an ECDSA leaf key's curve must be one we offered in
      // `supported_groups` (unlike TLS 1.3, where `signature_algorithms` constrains it).
      if (leafOid === EC_PUBLIC_KEY_OID) {
        const leafGroup = spkiEcNamedGroup(decodedLeaf.subjectPublicKeyInfo.der);
        if (leafGroup === undefined || !offeredGroupCodes.has(NAMED_GROUPS[leafGroup])) {
          return peer.failAlert('illegal_parameter');
        }
      }

      leafCert = decodedLeaf;
      validatedSpkiDer = pathRes.path.leafSubjectPublicKeyInfoDer;
      messages.push(msgBytes);
      expecting = 'server_key_exchange';
      continue;
    }

    if (expecting === 'server_key_exchange') {
      if (msg.kind !== 'server_key_exchange') {
        return peer.failAlert('unexpected_message');
      }
      const group = namedGroupFromCode(msg.namedCurve);
      if (group === undefined || !offeredGroupCodes.has(msg.namedCurve)) {
        return peer.failAlert('illegal_parameter');
      }
      const expectedLen = expectedKeyShareLength(group);
      if (
        msg.publicKey.length !== expectedLen ||
        (group !== 'x25519' && msg.publicKey[0] !== 0x04)
      ) {
        return peer.failAlert('illegal_parameter');
      }
      const scheme = tls12SignatureSchemeFromCode(msg.scheme);
      if (scheme === undefined || !offeredSchemes.includes(scheme)) {
        return peer.failAlert('illegal_parameter');
      }
      if (leafCert === undefined || validatedSpkiDer === undefined) {
        throw new Error('TLS 1.2 leaf certificate is undefined');
      }

      const verifyRes = await verifyServerKeyExchange({
        scheme: msg.scheme,
        signature: msg.signature,
        spkiDer: leafCert.subjectPublicKeyInfo.der,
        algorithmOid: leafCert.subjectPublicKeyInfo.algorithm.oid,
        clientRandom,
        serverRandom,
        serverParams: msg.serverParams,
      });
      if (!verifyRes.ok) {
        return peer.failAlert(verifyRes.description);
      }

      // Learned only after the server proves possession of the leaf key.
      peerPublicKeyPin = await publicKeyPin(validatedSpkiDer);
      negotiatedGroup = group;
      serverPublicKey = msg.publicKey;
      peerSignatureScheme = scheme;
      messages.push(msgBytes);
      expecting = 'cert_request_or_done';
      continue;
    }

    if (expecting === 'cert_request_or_done' && msg.kind === 'certificate_request') {
      wasCertificateRequested = true;
      messages.push(msgBytes);
      expecting = 'server_hello_done';
      continue;
    }

    if (msg.kind !== 'server_hello_done') {
      return peer.failAlert('unexpected_message');
    }

    messages.push(msgBytes);
    if (peer.hasBufferedHandshakeBytes()) {
      return peer.failAlert('unexpected_message');
    }
    break;
  }

  if (
    negotiatedGroup === undefined ||
    serverPublicKey === undefined ||
    peerSignatureScheme === undefined ||
    peerPublicKeyPin === undefined
  ) {
    throw new Error('TLS 1.2 ServerKeyExchange state incomplete');
  }

  const clientShare = await generateKeyShare(negotiatedGroup);
  const premasterSecret = await (async () => {
    try {
      return await deriveSharedSecret(negotiatedGroup, clientShare.privateKey, serverPublicKey);
    } catch {
      return undefined;
    }
  })();
  if (premasterSecret === undefined) {
    return peer.failAlert('illegal_parameter');
  }

  if (wasCertificateRequested) {
    const emptyCertMsg = encodeTls12HandshakeMessage({
      kind: 'certificate',
      certificateList: [],
    });
    messages.push(emptyCertMsg);
    if (!(await peer.writeToPeer(sealPlain('handshake', emptyCertMsg)))) {
      return { ok: false, reason: { kind: 'truncated' } };
    }
  }

  const ckeMsg = encodeTls12HandshakeMessage({
    kind: 'client_key_exchange',
    publicKey: clientShare.publicKey,
  });
  messages.push(ckeMsg);
  if (!(await peer.writeToPeer(sealPlain('handshake', ckeMsg)))) {
    return { ok: false, reason: { kind: 'truncated' } };
  }

  // RFC 7627 §3 / RFC 5246 §7.4.9: without a client CertificateVerify, the transcript through
  // ClientKeyExchange is both the EMS session_hash and the client Finished hash.
  const hashBeforeClientFinished = await tls12TranscriptHash(suite, ...messages);
  const masterSecret = hasExtendedMasterSecret
    ? await tls12ExtendedMasterSecret(suite, premasterSecret, hashBeforeClientFinished)
    : await tls12MasterSecret(suite, premasterSecret, clientRandom, serverRandom);
  const keys = await tls12KeyBlock(suite, masterSecret, clientRandom, serverRandom);

  if (!(await peer.writeToPeer(sealPlain('change_cipher_spec', Uint8Array.of(1))))) {
    return { ok: false, reason: { kind: 'truncated' } };
  }

  let clientWriteSeq = 0n;
  peer.setRecordSealer(
    createTls12AeadSealer(
      () => ({ key: keys.clientWriteKey, iv: keys.clientWriteIv, seq: clientWriteSeq }),
      () => {
        clientWriteSeq += 1n;
      },
    ),
  );

  const clientVerifyData = await tls12VerifyData(
    suite,
    masterSecret,
    'client',
    hashBeforeClientFinished,
  );
  const clientFinMsg = encodeTls12HandshakeMessage({
    kind: 'finished',
    verifyData: clientVerifyData,
  });
  messages.push(clientFinMsg);
  const sealedClientFin = await sealTls12Aead(
    keys.clientWriteKey,
    keys.clientWriteIv,
    clientWriteSeq,
    'handshake',
    clientFinMsg,
  );
  clientWriteSeq += 1n;
  if (!(await peer.writeToPeer(sealedClientFin))) {
    return { ok: false, reason: { kind: 'truncated' } };
  }

  // Server ChangeCipherSpec (plaintext, exact 1-byte body 0x01).
  while (true) {
    const ccsRecResult = await peer.reader.readRecord();
    if (!ccsRecResult.ok) {
      if (ccsRecResult.kind === 'truncated') {
        return { ok: false, reason: { kind: 'truncated' } };
      }
      return peer.failAlert(ccsRecResult.description);
    }
    if (ccsRecResult.kind === 'eof') {
      return { ok: false, reason: { kind: 'truncated' } };
    }

    const ccsPlain = openPlain(ccsRecResult.record);
    if (!ccsPlain.ok) {
      return peer.failAlert(ccsPlain.description);
    }
    if (ccsPlain.type === 'alert') {
      const verdict = classifyAlert(ccsPlain.payload);
      if (verdict === 'ignore') continue;
      if (verdict === 'too-many') return peer.failAlert('unexpected_message');
      return peer.failAlertPayload(ccsPlain.payload);
    }
    if (ccsPlain.type !== 'change_cipher_spec') {
      return peer.failAlert('unexpected_message');
    }
    if (ccsPlain.payload.length !== 1 || ccsPlain.payload[0] !== 1) {
      return peer.failAlert('decode_error');
    }
    if (peer.hasBufferedHandshakeBytes()) {
      return peer.failAlert('unexpected_message');
    }
    break;
  }

  // Server Finished (encrypted under serverWriteKey / serverWriteIv from seq 0).
  let serverReadSeq = 0n;
  let extractedFin = peer.extractNextHandshakeMessage();
  while (extractedFin.kind === 'need-more') {
    const finRecResult = await peer.reader.readRecord();
    if (!finRecResult.ok) {
      if (finRecResult.kind === 'truncated') {
        return { ok: false, reason: { kind: 'truncated' } };
      }
      return peer.failAlert(finRecResult.description);
    }
    if (finRecResult.kind === 'eof') {
      return { ok: false, reason: { kind: 'truncated' } };
    }

    const openRes = await openTls12Aead(
      keys.serverWriteKey,
      keys.serverWriteIv,
      serverReadSeq,
      finRecResult.record,
    );
    serverReadSeq += 1n;
    if (!openRes.ok) {
      return peer.failAlert(openRes.description);
    }
    if (openRes.type === 'alert') {
      const verdict = classifyAlert(openRes.payload);
      if (verdict === 'ignore') continue;
      if (verdict === 'too-many') return peer.failAlert('unexpected_message');
      return peer.failAlertPayload(openRes.payload);
    }
    if (openRes.type !== 'handshake' || openRes.payload.length === 0) {
      return peer.failAlert('unexpected_message');
    }

    peer.pushHandshakeBytes(openRes.payload);
    extractedFin = peer.extractNextHandshakeMessage();
  }

  if (extractedFin.kind === 'overflow') {
    return peer.failAlert('decode_error');
  }

  if (extractedFin.bytes[0] !== HANDSHAKE_TYPES.finished) {
    return peer.failAlert('unexpected_message');
  }

  const decodedFin = decodeTls12HandshakeMessage(extractedFin.bytes);
  if (!decodedFin.ok) {
    return peer.failAlert(decodedFin.description);
  }
  if (decodedFin.value.kind !== 'finished') {
    return peer.failAlert('unexpected_message');
  }

  const serverExpectedHash = await tls12TranscriptHash(suite, ...messages);
  const isServerFinValid = await isTls12VerifyDataValid(
    suite,
    masterSecret,
    'server',
    serverExpectedHash,
    decodedFin.value.verifyData,
  );
  if (!isServerFinValid) {
    return peer.failAlert('decrypt_error');
  }

  if (peer.hasBufferedHandshakeBytes()) {
    return peer.failAlert('unexpected_message');
  }

  return {
    ok: true,
    value: {
      suite,
      negotiatedGroup,
      peerSignatureScheme,
      peerPublicKeyPin,
      masterSecret,
      clientRandom,
      serverRandom,
      keys,
      clientWriteSeq,
      serverReadSeq,
    },
  };
};
