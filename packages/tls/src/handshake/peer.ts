import type {
  PathValidationResult,
  PeerName,
  TrustAnchorSource,
  ValidationFailure,
  Validator,
} from '@yozz.app/x509';
import {
  type Alert,
  alertForValidationFailure,
  decodeAlert,
  encodeAlert,
  type TlsFailure,
} from '../alert.ts';
import { concat, readUint24 } from '../bytes.ts';
import type { Extension } from '../handshake-messages.ts';
import {
  MAX_RECORD_PLAINTEXT,
  RecordReader,
  sealAead,
  sealPlain,
  sealTls12Aead,
} from '../record.ts';
import type { PeerCertificateChain } from '../session.ts';
import type { ByteDuplex } from '../transport.ts';
import { type ContentType, EXTENSION_TYPES, type NamedGroup } from '../wire.ts';

/** The uint24 allows 16 MB. BoGo's `LargeMessage` sends a 23 KB chain and expects it to arrive. */
export const MAX_HANDSHAKE_MESSAGE_BODY = 65536;

/** BoringSSL's consecutive warning-alert ceiling (pinned by BoGo). */
export const MAX_WARNING_ALERTS = 4;

export type HandshakeFailure = { readonly ok: false; readonly reason: TlsFailure };

export type ExtractResult =
  | { readonly kind: 'message'; readonly bytes: Uint8Array }
  | { readonly kind: 'need-more' }
  | { readonly kind: 'overflow' };

export type RecordSealer = (type: ContentType, payload: Uint8Array) => Promise<Uint8Array>;

export const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export const expectedKeyShareLength = (group: NamedGroup): number => {
  if (group === 'x25519') return 32;
  if (group === 'secp256r1') return 65;
  return 97;
};

export const extensionTypeCode = (extension: Extension): number =>
  extension.kind === 'unknown' ? extension.typeCode : EXTENSION_TYPES[extension.kind];

export const misplacedExtensionAlert = (
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

/** RFC 9846 §5.1 allows fragmenting, and a peer-sized ticket or cookie can overrun one record. */
export const clientHelloRecords = (
  message: Uint8Array,
  legacyVersion: number,
): readonly Uint8Array[] =>
  Array.from({ length: Math.ceil(message.length / MAX_RECORD_PLAINTEXT) }, (_, index) =>
    sealPlain(
      'handshake',
      message.subarray(index * MAX_RECORD_PLAINTEXT, (index + 1) * MAX_RECORD_PLAINTEXT),
      legacyVersion,
    ),
  );

export type HandshakePeer = {
  readonly transport: ByteDuplex;
  readonly reader: RecordReader;
  readonly pushHandshakeBytes: (bytes: Uint8Array) => void;
  readonly extractNextHandshakeMessage: () => ExtractResult;
  readonly hasBufferedHandshakeBytes: () => boolean;
  readonly setCompatibilityCcsPending: (pending: boolean) => void;
  readonly sendCompatibilityCcsIfPending: () => Promise<void>;
  readonly setRecordSealer: (sealer: RecordSealer | null) => void;
  readonly writeToPeer: (record: Uint8Array) => Promise<boolean>;
  readonly sendFatalAlert: (description: Alert['description']) => Promise<void>;
  readonly failAlert: (description: Alert['description']) => Promise<HandshakeFailure>;
  readonly failAlertPayload: (payload: Uint8Array) => Promise<HandshakeFailure>;
  readonly validatePeerChain: (chain: PeerCertificateChain) => Promise<PathValidationResult>;
  readonly failValidation: (
    reason: ValidationFailure,
    chain: 'peer-sent' | 'session-stored',
  ) => Promise<HandshakeFailure>;
};

export const createAeadSealer =
  (
    getState: () => { readonly key: Uint8Array; readonly iv: Uint8Array; readonly seq: bigint },
    advanceSeq: () => void,
    beforeSeal?: () => Promise<void>,
  ): RecordSealer =>
  async (type, payload) => {
    if (beforeSeal !== undefined) {
      await beforeSeal();
    }
    const { key, iv, seq } = getState();
    const sealed = await sealAead(key, iv, seq, type, payload);
    advanceSeq();
    return sealed;
  };

export const createTls12AeadSealer =
  (
    getState: () => { readonly key: Uint8Array; readonly iv: Uint8Array; readonly seq: bigint },
    advanceSeq: () => void,
  ): RecordSealer =>
  async (type, payload) => {
    const { key, iv, seq } = getState();
    const sealed = await sealTls12Aead(key, iv, seq, type, payload);
    advanceSeq();
    return sealed;
  };

export const createHandshakePeer = ({
  transport,
  validator,
  trustAnchors,
  validationTime,
  expectedPeerName,
}: {
  readonly transport: ByteDuplex;
  readonly validator: Validator;
  readonly trustAnchors: TrustAnchorSource;
  readonly validationTime: Temporal.Instant;
  readonly expectedPeerName: PeerName | null;
}): HandshakePeer => {
  const reader = new RecordReader(() => transport.read());
  const handshakeBuffer: Uint8Array[] = [];
  // RFC 9846 D.4: once, immediately before the second flight, which may be a retried ClientHello,
  // the Finished flight or an early fatal alert.
  let compatibilityCcsPending = false;
  let recordSealer: RecordSealer | null = null;

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
      if (recordSealer === null) {
        await transport.write(sealPlain('alert', alertBytes));
        return;
      }
      const sealed = await recordSealer('alert', alertBytes);
      await transport.write(sealed);
    } catch {
      // Aborting anyway.
    }
  };

  const failAlert = async (description: Alert['description']): Promise<HandshakeFailure> => {
    await sendFatalAlert(description);
    return {
      ok: false,
      reason: {
        kind: 'alert-sent',
        alert: { level: 'fatal', description },
      },
    };
  };

  const failAlertPayload = async (payload: Uint8Array): Promise<HandshakeFailure> => {
    const alertRes = decodeAlert(payload);
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
  };

  return {
    transport,
    reader,
    pushHandshakeBytes: bytes => {
      handshakeBuffer.push(bytes);
    },
    extractNextHandshakeMessage: () => {
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
    },
    hasBufferedHandshakeBytes: () => handshakeBuffer.some(chunk => chunk.length > 0),
    setCompatibilityCcsPending: pending => {
      compatibilityCcsPending = pending;
    },
    sendCompatibilityCcsIfPending,
    setRecordSealer: sealer => {
      recordSealer = sealer;
    },
    writeToPeer,
    sendFatalAlert,
    failAlert,
    failAlertPayload,
    // Both path validations, peer-sent and session-stored, must ask the same question.
    validatePeerChain: chain =>
      validator.validatePath({
        peerCertificateDer: chain.leafDer,
        untrustedIntermediateDer: chain.intermediateDer,
        trustAnchors,
        validationTime,
        expectedPeerName,
        requiredKeyUsages: ['digitalSignature'],
        // Names, not OIDs: `@yozz.app/x509` looks these up in its own table.
        requiredExtendedKeyUsages: ['serverAuth'],
        maximumIntermediateCount: null,
      }),
    failValidation: async (reason, chain) => {
      const alert = alertForValidationFailure(reason);
      await sendFatalAlert(alert.description);
      return { ok: false, reason: { kind: 'certificate', reason, alert, chain } };
    },
  };
};
