import { concat, writeUint8, writeUint16 } from './bytes.ts';
import {
  type AlertDescription,
  CONTENT_TYPES,
  type ContentType,
  LEGACY_RECORD_VERSION,
} from './wire.ts';

const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/** 2^14 of content, plus the one byte naming its type (RFC 9846 §5.2). */
const MAX_INNER_PLAINTEXT = 16385;

export type OpenRecordResult =
  | {
      readonly ok: true;
      readonly type: ContentType;
      readonly payload: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly description: AlertDescription;
    };

export type AeadRecordEvent = {
  readonly direction: 'seal' | 'open';
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly seq: bigint;
  /** The inner content type, so a test can assert no application data was ever sent. */
  readonly type: ContentType;
};

type AeadObserver = (event: AeadRecordEvent) => void;

let aeadObserver: AeadObserver | null = null;

/** Test-only. */
export const setAeadObserver = (observer: AeadObserver | null): void => {
  aeadObserver = observer;
};

/** RFC 9846 §5.1. */
export const MAX_RECORD_PLAINTEXT = 16384;

export const sealPlain = (
  type: ContentType,
  payload: Uint8Array,
  legacyVersion: number = LEGACY_RECORD_VERSION.STANDARD,
): Uint8Array<ArrayBuffer> => {
  if (payload.length > MAX_RECORD_PLAINTEXT) {
    throw new Error('record_overflow');
  }
  const typeCode = CONTENT_TYPES[type];
  if (typeCode === undefined) {
    throw new Error(`Unknown content type: ${type}`);
  }
  return concat(
    writeUint8(typeCode),
    writeUint16(legacyVersion),
    writeUint16(payload.length),
    payload,
  );
};

export const openPlain = (record: Uint8Array): OpenRecordResult => {
  if (record.length < 5) {
    return { ok: false, description: 'decode_error' };
  }
  const typeCode = record[0];
  const v0 = record[1];
  const v1 = record[2];
  const l0 = record[3];
  const l1 = record[4];
  if (
    typeCode === undefined ||
    v0 === undefined ||
    v1 === undefined ||
    l0 === undefined ||
    l1 === undefined
  ) {
    return { ok: false, description: 'decode_error' };
  }
  // RFC 9846 §5.1: legacy_record_version "MUST be ignored for all purposes".
  const length = (l0 << 8) | l1;
  if (length > MAX_RECORD_PLAINTEXT) {
    return { ok: false, description: 'record_overflow' };
  }
  if (record.length !== 5 + length) {
    return { ok: false, description: 'decode_error' };
  }
  const type = (Object.entries(CONTENT_TYPES) as readonly [ContentType, number][]).find(
    ([, code]) => code === typeCode,
  )?.[0];
  if (type === undefined) {
    return { ok: false, description: 'decode_error' };
  }
  return { ok: true, type, payload: record.subarray(5) };
};

export const buildNonce = (iv: Uint8Array, seq: bigint | number): Uint8Array<ArrayBuffer> => {
  if (iv.length !== 12) {
    throw new Error(`AEAD IV must be 12 octets, got ${iv.length}`);
  }
  const nonce = new Uint8Array(12);
  nonce.set(iv);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(seq), false);
  for (let i = 0; i < 8; i += 1) {
    const b = nonce[4 + i];
    const s = view.getUint8(i);
    if (b !== undefined) {
      nonce[4 + i] = b ^ s;
    }
  }
  return nonce;
};

export const sealAead = async (
  key: Uint8Array | CryptoKey,
  iv: Uint8Array,
  seq: bigint | number,
  type: ContentType,
  payload: Uint8Array,
  paddingZeros: number = 0,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (payload.length > MAX_RECORD_PLAINTEXT) {
    throw new Error('record_overflow');
  }
  const typeCode = CONTENT_TYPES[type];
  if (typeCode === undefined) {
    throw new Error(`Unknown content type: ${type}`);
  }

  const innerPlaintext = new Uint8Array(payload.length + 1 + paddingZeros);
  innerPlaintext.set(payload, 0);
  innerPlaintext[payload.length] = typeCode;

  const ciphertextLength = innerPlaintext.length + 16;
  if (ciphertextLength > MAX_RECORD_PLAINTEXT + 256) {
    throw new Error('record_overflow');
  }

  const aad = Uint8Array.of(
    CONTENT_TYPES.application_data,
    0x03,
    0x03,
    (ciphertextLength >> 8) & 0xff,
    ciphertextLength & 0xff,
  );

  const nonce = buildNonce(iv, seq);

  if (aeadObserver !== null) {
    const rawKey = key instanceof CryptoKey ? new Uint8Array(0) : key;
    aeadObserver({ direction: 'seal', key: rawKey, nonce, seq: BigInt(seq), type });
  }

  const cryptoKey =
    key instanceof CryptoKey
      ? key
      : await crypto.subtle.importKey('raw', nonShared(key), { name: 'AES-GCM' }, false, [
          'encrypt',
        ]);

  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      cryptoKey,
      nonShared(innerPlaintext),
    ),
  );

  return concat(aad, ciphertextWithTag);
};

export const openAead = async (
  key: Uint8Array | CryptoKey,
  iv: Uint8Array,
  seq: bigint | number,
  record: Uint8Array,
): Promise<OpenRecordResult> => {
  if (record.length < 5) {
    return { ok: false, description: 'decode_error' };
  }
  const outerType = record[0];
  const v0 = record[1];
  const v1 = record[2];
  const l0 = record[3];
  const l1 = record[4];
  if (
    outerType === undefined ||
    v0 === undefined ||
    v1 === undefined ||
    l0 === undefined ||
    l1 === undefined
  ) {
    return { ok: false, description: 'decode_error' };
  }

  if (outerType !== CONTENT_TYPES.application_data) {
    return { ok: false, description: 'decode_error' };
  }

  // §5.2: on a TLSCiphertext the version "is always 0x0303", unlike the plaintext field §5.1 ignores.
  if (((v0 << 8) | v1) !== LEGACY_RECORD_VERSION.STANDARD) {
    return { ok: false, description: 'decode_error' };
  }

  const length = (l0 << 8) | l1;
  if (length > MAX_RECORD_PLAINTEXT + 256) {
    return { ok: false, description: 'record_overflow' };
  }

  if (record.length !== 5 + length) {
    return { ok: false, description: 'decode_error' };
  }

  // Too short for a tag; §5.2 names bad_record_mac for a decryption that fails.
  if (length < 17) {
    return { ok: false, description: 'bad_record_mac' };
  }

  const aad = record.subarray(0, 5);
  const ciphertextWithTag = record.subarray(5);

  const nonce = buildNonce(iv, seq);

  const cryptoKey =
    key instanceof CryptoKey
      ? key
      : await crypto.subtle.importKey('raw', nonShared(key), { name: 'AES-GCM' }, false, [
          'decrypt',
        ]);

  let innerPlaintext: Uint8Array;
  try {
    innerPlaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonShared(nonce), additionalData: nonShared(aad), tagLength: 128 },
        cryptoKey,
        nonShared(ciphertextWithTag),
      ),
    );
  } catch {
    return { ok: false, description: 'bad_record_mac' };
  }

  // §5.2: 2^14 of content plus the type byte, padding included.
  if (innerPlaintext.length > MAX_INNER_PLAINTEXT) {
    return { ok: false, description: 'record_overflow' };
  }

  let i = innerPlaintext.length - 1;
  while (i >= 0 && innerPlaintext[i] === 0) {
    i -= 1;
  }
  // §5.4: no non-zero octet means no content type.
  if (i < 0) {
    return { ok: false, description: 'unexpected_message' };
  }

  const innerTypeCode = innerPlaintext[i];
  const payload = innerPlaintext.subarray(0, i);

  const type = (Object.entries(CONTENT_TYPES) as readonly [ContentType, number][]).find(
    ([, code]) => code === innerTypeCode,
  )?.[0];
  // §5.1: a record type we do not recognise is an unexpected record.
  if (type === undefined) {
    return { ok: false, description: 'unexpected_message' };
  }

  if (aeadObserver !== null) {
    const rawKey = key instanceof CryptoKey ? new Uint8Array(0) : key;
    aeadObserver({ direction: 'open', key: rawKey, nonce, seq: BigInt(seq), type });
  }

  return { ok: true, type, payload };
};

export type RecordReaderResult =
  | { readonly ok: true; readonly kind: 'record'; readonly record: Uint8Array }
  | { readonly ok: true; readonly kind: 'eof' }
  | { readonly ok: false; readonly kind: 'truncated' }
  | { readonly ok: false; readonly kind: 'alert'; readonly description: AlertDescription };

export class RecordReader {
  private buffer = new Uint8Array(0);
  private readonly readChunk: () => Promise<Uint8Array | null>;

  constructor(readChunk?: () => Promise<Uint8Array | null>) {
    this.readChunk = readChunk ?? (() => Promise.resolve(null));
  }

  feed(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
  }

  async readRecord(): Promise<RecordReaderResult> {
    while (this.buffer.length < 5) {
      const chunk = await this.readChunk();
      if (chunk === null) {
        if (this.buffer.length === 0) {
          return { ok: true, kind: 'eof' };
        }
        return { ok: false, kind: 'truncated' };
      }
      this.buffer = concat(this.buffer, chunk);
    }

    const v0 = this.buffer[1];
    const v1 = this.buffer[2];
    const l0 = this.buffer[3];
    const l1 = this.buffer[4];
    if (v0 === undefined || v1 === undefined || l0 === undefined || l1 === undefined) {
      return { ok: false, kind: 'alert', description: 'decode_error' };
    }

    // §5.1: legacy_record_version is ignored, so an SSL 3.0-framed alert is still read.
    const length = (l0 << 8) | l1;
    if (length > MAX_RECORD_PLAINTEXT + 256) {
      return { ok: false, kind: 'alert', description: 'record_overflow' };
    }

    const totalRecordLength = 5 + length;
    while (this.buffer.length < totalRecordLength) {
      const chunk = await this.readChunk();
      if (chunk === null) {
        return { ok: false, kind: 'truncated' };
      }
      this.buffer = concat(this.buffer, chunk);
    }

    const record = this.buffer.subarray(0, totalRecordLength);
    this.buffer = this.buffer.subarray(totalRecordLength);
    return { ok: true, kind: 'record', record };
  }
}
