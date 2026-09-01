/** RFC 9846 §7.1. WebCrypto's `HKDF` fuses extract and expand, and TLS needs them apart, so both are HMAC here. */

export type CipherSuite = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384';

type CipherSuiteParameters = {
  /** RFC 9846 App. B.4. */
  readonly code: number;
  readonly hash: 'SHA-256' | 'SHA-384';
  readonly hashLength: number;
  readonly keyLength: number;
  /** RFC 9846 §5.3. */
  readonly ivLength: number;
};

/** `posteo.de` takes only the second. ChaCha20 is absent: WebCrypto has none. */
export const CIPHER_SUITES: Readonly<Record<CipherSuite, CipherSuiteParameters>> = {
  TLS_AES_128_GCM_SHA256: {
    code: 0x1301,
    hash: 'SHA-256',
    hashLength: 32,
    keyLength: 16,
    ivLength: 12,
  },
  TLS_AES_256_GCM_SHA384: {
    code: 0x1302,
    hash: 'SHA-384',
    hashLength: 48,
    keyLength: 32,
    ivLength: 12,
  },
};

const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/** WebCrypto's types want a buffer proven not to be shared, which a view cannot prove. */
const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const hmac = async (
  hash: CipherSuiteParameters['hash'],
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey('raw', nonShared(key), { name: 'HMAC', hash }, false, ['sign']),
      nonShared(message),
    ),
  );

/** RFC 5869 §2.1. WebCrypto refuses a zero-length HMAC key, so an empty salt becomes HashLen zeros. */
export const hkdfExtract = (
  suite: CipherSuite,
  salt: Uint8Array,
  ikm: Uint8Array,
): Promise<Uint8Array> => {
  const { hash, hashLength } = CIPHER_SUITES[suite];
  return hmac(hash, salt.length === 0 ? new Uint8Array(hashLength) : salt, ikm);
};

/** RFC 5869 §2.3. */
const hkdfExpand = async (
  suite: CipherSuite,
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  const { hash, hashLength } = CIPHER_SUITES[suite];
  // A fractional or NaN length would be coerced into key material of the wrong size.
  if (!Number.isInteger(length) || length < 0 || length > 255 * hashLength) {
    throw new Error(`HKDF-Expand cannot produce ${length} octets under ${hash}`);
  }
  const output = new Uint8Array(length);
  let block = new Uint8Array(0);
  for (let counter = 1; (counter - 1) * hashLength < length; counter += 1) {
    block = await hmac(hash, prk, concat(block, info, Uint8Array.of(counter)));
    output.set(block.subarray(0, length - (counter - 1) * hashLength), (counter - 1) * hashLength);
  }
  return output;
};

/** RFC 9846 §7.1 `HkdfLabel`. */
const hkdfLabel = (label: string, context: Uint8Array, length: number): Uint8Array => {
  const prefixed = new TextEncoder().encode(`tls13 ${label}`);
  // `opaque label<7..255>`.
  if (prefixed.length < 7 || prefixed.length > 255) {
    throw new Error(`HkdfLabel label must be 7..255 octets, got ${prefixed.length}: "${label}"`);
  }
  if (context.length > 255) throw new Error('HkdfLabel context is over 255 octets');
  return concat(
    Uint8Array.of(length >> 8, length & 0xff),
    Uint8Array.of(prefixed.length),
    prefixed,
    Uint8Array.of(context.length),
    context,
  );
};

/** `async` so a rejected label rejects the promise rather than throwing synchronously. */
export const hkdfExpandLabel = async (
  suite: CipherSuite,
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> => hkdfExpand(suite, secret, hkdfLabel(label, context, length), length);

/**
 * RFC 9846 §7.1 `Derive-Secret`, taking MESSAGES and hashing them as the RFC's signature does.
 * Pass nothing for the empty transcript; for an empty context (the `finished` key) use `hkdfExpandLabel`.
 */
export const deriveSecret = async (
  suite: CipherSuite,
  secret: Uint8Array,
  label: string,
  ...messages: readonly Uint8Array[]
): Promise<Uint8Array> =>
  hkdfExpandLabel(
    suite,
    secret,
    label,
    await transcriptHash(suite, ...messages),
    CIPHER_SUITES[suite].hashLength,
  );

export const transcriptHash = async (
  suite: CipherSuite,
  ...messages: readonly Uint8Array[]
): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest(CIPHER_SUITES[suite].hash, concat(...messages)));

/** The three Extracts. `Derive-Secret(., "derived", "")` between them hashes the EMPTY transcript. */
export const earlySecret = (suite: CipherSuite, psk?: Uint8Array): Promise<Uint8Array> =>
  hkdfExtract(suite, new Uint8Array(0), psk ?? new Uint8Array(CIPHER_SUITES[suite].hashLength));

export const handshakeSecret = async (
  suite: CipherSuite,
  early: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<Uint8Array> =>
  hkdfExtract(suite, await deriveSecret(suite, early, 'derived'), sharedSecret);

export const masterSecret = async (
  suite: CipherSuite,
  handshake: Uint8Array,
): Promise<Uint8Array> =>
  hkdfExtract(
    suite,
    await deriveSecret(suite, handshake, 'derived'),
    new Uint8Array(CIPHER_SUITES[suite].hashLength),
  );

/**
 * RFC 9846 §7.5:
 *
 * ```
 * TLS-Exporter(label, context_value, key_length) =
 *     HKDF-Expand-Label(Derive-Secret(Secret, label, ""),
 *                       "exporter", Hash(context_value), key_length)
 * ```
 *
 * The only caller that reaches `hkdfExpand`'s multi-block loop: BoGo asks for 1024 octets.
 */
export const exportKeyingMaterial = async (
  suite: CipherSuite,
  exporterMaster: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> =>
  hkdfExpandLabel(
    suite,
    await deriveSecret(suite, exporterMaster, label),
    'exporter',
    await transcriptHash(suite, context),
    length,
  );

export type TrafficKeys = { readonly key: Uint8Array; readonly iv: Uint8Array };

/** RFC 9846 §7.3. */
export const trafficKeys = async (suite: CipherSuite, secret: Uint8Array): Promise<TrafficKeys> => {
  const { keyLength, ivLength } = CIPHER_SUITES[suite];
  const [key, iv] = await Promise.all([
    hkdfExpandLabel(suite, secret, 'key', new Uint8Array(0), keyLength),
    hkdfExpandLabel(suite, secret, 'iv', new Uint8Array(0), ivLength),
  ]);
  return { key, iv };
};

/** RFC 9846 §4.5.3. */
export const finishedKey = (suite: CipherSuite, baseKey: Uint8Array): Promise<Uint8Array> =>
  hkdfExpandLabel(suite, baseKey, 'finished', new Uint8Array(0), CIPHER_SUITES[suite].hashLength);

export const verifyData = (
  suite: CipherSuite,
  key: Uint8Array,
  transcript: Uint8Array,
): Promise<Uint8Array> => hmac(CIPHER_SUITES[suite].hash, key, transcript);

/** Through `subtle.verify`, which is constant-time. */
export const isVerifyDataValid = async (
  suite: CipherSuite,
  key: Uint8Array,
  transcript: Uint8Array,
  received: Uint8Array,
): Promise<boolean> =>
  crypto.subtle.verify(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      nonShared(key),
      { name: 'HMAC', hash: CIPHER_SUITES[suite].hash },
      false,
      ['verify'],
    ),
    nonShared(received),
    nonShared(transcript),
  );
