/**
 * TLS 1.3's key schedule — RFC 9846 §7.1 — over WebCrypto.
 *
 * **WebCrypto's own `HKDF` algorithm is unusable here.** It fuses extract and
 * expand, and TLS needs the halves apart: a bare Extract for the Early,
 * Handshake and Master secrets, and a bare Expand-Label everywhere else. Both
 * are a few lines over `subtle.sign('HMAC')`, and every one of them is checked
 * byte-for-byte against RFC 8448's five traces in the test beside this file.
 *
 * Nothing here knows what a record or a handshake message is. The transcript
 * arrives already hashed, which is what lets the schedule be proven against the
 * RFC before a single byte is framed.
 */

export type CipherSuite = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384';

type CipherSuiteParameters = {
  /** The wire code point, RFC 9846 App. B.4. */
  readonly code: number;
  readonly hash: 'SHA-256' | 'SHA-384';
  readonly hashLength: number;
  readonly keyLength: number;
  /** RFC 9846 §5.3: the AEAD nonce, which is 12 octets for both AES-GCM suites. */
  readonly ivLength: number;
};

/**
 * The two suites the spike measured as necessary and sufficient across real mail
 * providers — `posteo.de` takes only the second. `TLS_CHACHA20_POLY1305_SHA256`
 * is deliberately absent: WebCrypto has no ChaCha20, and RFC 9846 keeps it
 * optional.
 */
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

/**
 * WebCrypto's types demand a buffer proven not to be shared, which a view into a
 * caller's array cannot prove — the same boundary `@yozz.app/x509`'s verifier copies
 * at, for the same reason. Handshake-sized, and against an HMAC.
 */
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

/**
 * RFC 5869 §2.1. An empty salt means HashLen zero octets — which is also how RFC
 * 8446 §7.1 draws the Early Secret's `0` — and the substitution is not optional:
 * WebCrypto refuses a zero-length HMAC key outright.
 */
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
  // Fractional and NaN lengths would otherwise be coerced twice over — once by
  // the uint16 in `HkdfLabel`, once by the allocation — and yield plausible key
  // material of the wrong size rather than an error.
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

/**
 * The `HkdfLabel` struct of RFC 9846 §7.1 — a uint16 length, then the label
 * under a `tls13 ` prefix and the context, each with a one-octet length. Getting
 * this wrong produces keys that are simply different, so it fails at `Finished`
 * with `decrypt_error` and never nearer the cause.
 */
const hkdfLabel = (label: string, context: Uint8Array, length: number): Uint8Array => {
  const prefixed = new TextEncoder().encode(`tls13 ${label}`);
  // `opaque label<7..255>` — the floor is what rejects an empty label, which
  // would otherwise encode as a bare `tls13 ` and derive real-looking keys.
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

/**
 * `async` so that a rejected label fails the same way a rejected length does.
 * Without it `hkdfLabel` throws synchronously, as an argument evaluated before
 * the call, and a caller using `.catch()` rather than `await` would miss it.
 */
export const hkdfExpandLabel = async (
  suite: CipherSuite,
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> => hkdfExpand(suite, secret, hkdfLabel(label, context, length), length);

/**
 * RFC 9846 §7.1's `Derive-Secret(Secret, Label, Messages)` — and it takes
 * MESSAGES, hashing them itself, because that is what the RFC's signature says.
 *
 * An earlier shape took the transcript pre-hashed while keeping this name. That
 * invites a handshake author reading the RFC to pass `ClientHello ‖ ServerHello`
 * straight in, which derives a secret that is merely different: every such bug
 * surfaces at `Finished` as `decrypt_error`, nowhere near the cause. Pass
 * nothing for the empty transcript. For the one derivation that takes an EMPTY
 * context rather than `Hash("")` — the `finished` key — use `hkdfExpandLabel`.
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

/** `Transcript-Hash` over the handshake messages as they went on the wire. */
export const transcriptHash = async (
  suite: CipherSuite,
  ...messages: readonly Uint8Array[]
): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest(CIPHER_SUITES[suite].hash, concat(...messages)));

/**
 * The three Extracts of the schedule, each folding in the one input it exists
 * for. `Derive-Secret(., "derived", "")` between them is the step that is easy
 * to forget, and it hashes the EMPTY transcript rather than the handshake so
 * far.
 */
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
 * RFC 9846 §7.5's `TLS-Exporter`, verbatim:
 *
 * ```
 * TLS-Exporter(label, context_value, key_length) =
 *     HKDF-Expand-Label(Derive-Secret(Secret, label, ""),
 *                       "exporter", Hash(context_value), key_length)
 * ```
 *
 * `Secret` is the `exporter_master_secret`, and the caller holds it because
 * this module never holds a connection. Note the two DIFFERENT hashes: the
 * inner `Derive-Secret` hashes the EMPTY string, which is why it takes no
 * messages, and the outer one hashes the caller's context.
 *
 * **This is the only caller that can reach `hkdfExpand`'s multi-block loop.**
 * Every expansion in a TLS 1.3 schedule is at most one hash length, so T(1) is
 * all a handshake ever runs; an exporter is the one that asks for more, and
 * BoGo asks for 1024 octets — 32 blocks under SHA-256, 16 under SHA-384.
 *
 * `key_length` is bounded by HKDF itself (255 × hashLength) and `hkdfExpand`
 * rejects anything past it, so a caller asking for a megabyte gets an error
 * rather than a truncated key.
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

/** RFC 9846 §7.3. Both halves come off the same traffic secret. */
export const trafficKeys = async (suite: CipherSuite, secret: Uint8Array): Promise<TrafficKeys> => {
  const { keyLength, ivLength } = CIPHER_SUITES[suite];
  const [key, iv] = await Promise.all([
    hkdfExpandLabel(suite, secret, 'key', new Uint8Array(0), keyLength),
    hkdfExpandLabel(suite, secret, 'iv', new Uint8Array(0), ivLength),
  ]);
  return { key, iv };
};

/** RFC 9846 §4.5.3. The base key is the sender's handshake traffic secret. */
export const finishedKey = (suite: CipherSuite, baseKey: Uint8Array): Promise<Uint8Array> =>
  hkdfExpandLabel(suite, baseKey, 'finished', new Uint8Array(0), CIPHER_SUITES[suite].hashLength);

/** Our own `Finished.verify_data`, to send. */
export const verifyData = (
  suite: CipherSuite,
  key: Uint8Array,
  transcript: Uint8Array,
): Promise<Uint8Array> => hmac(CIPHER_SUITES[suite].hash, key, transcript);

/**
 * Their `Finished.verify_data`, to check — through `subtle.verify`, which is
 * constant-time, rather than a byte comparison that is not. Correctness here is
 * free, so there is no reason to spend a timing side channel on it.
 */
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
