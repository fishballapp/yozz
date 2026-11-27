/** The TLS 1.2 key schedule: RFC 5246 §5's PRF, RFC 7627's extended master secret, RFC 5705's exporter. */
import { concat, writeUint16 } from './bytes.ts';
import { TLS_1_2_CIPHER_SUITES, type Tls12CipherSuite } from './wire.ts';

/** WebCrypto's types want a buffer proven not to be shared, which a view cannot prove. */
const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const MASTER_SECRET_LENGTH = 48;
const VERIFY_DATA_LENGTH = 12;

/** RFC 5246 §5: `P_hash`, under the suite's own hash (RFC 5289 §3), never SHA-1/MD5. */
export const tls12Prf = async (
  suite: Tls12CipherSuite,
  secret: Uint8Array,
  label: string,
  seed: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  // A fractional or NaN length would be coerced into key material of the wrong size.
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`TLS 1.2 PRF cannot produce ${length} octets`);
  }
  const { hash } = TLS_1_2_CIPHER_SUITES[suite];
  const key = await crypto.subtle.importKey(
    'raw',
    nonShared(secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  const hmac = async (message: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await crypto.subtle.sign('HMAC', key, nonShared(message)));

  const labelledSeed = concat(new TextEncoder().encode(label), seed);
  const blocks: Uint8Array[] = [];
  let produced = 0;
  // A(0) = seed; A(i) = HMAC(secret, A(i-1)).
  let a: Uint8Array = labelledSeed;
  while (produced < length) {
    a = await hmac(a);
    const block = await hmac(concat(a, labelledSeed));
    blocks.push(block);
    produced += block.length;
  }
  return concat(...blocks).slice(0, length);
};

/** RFC 5246 §7.4.9: the hash of every handshake message so far, under the suite's PRF hash. */
export const tls12TranscriptHash = async (
  suite: Tls12CipherSuite,
  ...messages: readonly Uint8Array[]
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.digest(TLS_1_2_CIPHER_SUITES[suite].hash, concat(...messages)),
  );

/** RFC 5246 §8.1. Only for a server that refuses `extended_master_secret`. */
export const tls12MasterSecret = (
  suite: Tls12CipherSuite,
  premasterSecret: Uint8Array,
  clientRandom: Uint8Array,
  serverRandom: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> =>
  tls12Prf(
    suite,
    premasterSecret,
    'master secret',
    concat(clientRandom, serverRandom),
    MASTER_SECRET_LENGTH,
  );

/** RFC 7627 §4: binds the master secret to the whole handshake up to ClientKeyExchange. */
export const tls12ExtendedMasterSecret = (
  suite: Tls12CipherSuite,
  premasterSecret: Uint8Array,
  sessionHash: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> =>
  tls12Prf(suite, premasterSecret, 'extended master secret', sessionHash, MASTER_SECRET_LENGTH);

export type Tls12KeyBlock = {
  readonly clientWriteKey: Uint8Array<ArrayBuffer>;
  readonly serverWriteKey: Uint8Array<ArrayBuffer>;
  /** RFC 5288 §3: the 4-octet implicit half of the GCM nonce. */
  readonly clientWriteIv: Uint8Array<ArrayBuffer>;
  readonly serverWriteIv: Uint8Array<ArrayBuffer>;
};

/** RFC 5246 §6.3. The seed is server random first, the reverse of the master secret's. */
export const tls12KeyBlock = async (
  suite: Tls12CipherSuite,
  masterSecret: Uint8Array,
  clientRandom: Uint8Array,
  serverRandom: Uint8Array,
): Promise<Tls12KeyBlock> => {
  const { keyLength, implicitIvLength } = TLS_1_2_CIPHER_SUITES[suite];
  const block = await tls12Prf(
    suite,
    masterSecret,
    'key expansion',
    concat(serverRandom, clientRandom),
    2 * keyLength + 2 * implicitIvLength,
  );
  // AEAD suites have no MAC keys, so the block is the keys, then the IVs.
  return {
    clientWriteKey: block.slice(0, keyLength),
    serverWriteKey: block.slice(keyLength, 2 * keyLength),
    clientWriteIv: block.slice(2 * keyLength, 2 * keyLength + implicitIvLength),
    serverWriteIv: block.slice(2 * keyLength + implicitIvLength),
  };
};

/** RFC 5246 §7.4.9. */
export const tls12VerifyData = (
  suite: Tls12CipherSuite,
  masterSecret: Uint8Array,
  role: 'client' | 'server',
  handshakeHash: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> =>
  tls12Prf(suite, masterSecret, `${role} finished`, handshakeHash, VERIFY_DATA_LENGTH);

/** No early return on the first differing byte, so the comparison leaks no prefix length. */
export const isTls12VerifyDataValid = async (
  suite: Tls12CipherSuite,
  masterSecret: Uint8Array,
  role: 'client' | 'server',
  handshakeHash: Uint8Array,
  received: Uint8Array,
): Promise<boolean> => {
  if (received.length !== VERIFY_DATA_LENGTH) return false;
  const expected = await tls12VerifyData(suite, masterSecret, role, handshakeHash);
  return expected.reduce((diff, byte, index) => diff | (byte ^ (received[index] ?? 0)), 0) === 0;
};

/** RFC 5705 §6 / RFC 7627 §4: handshake PRF labels MUST NOT be exported. */
const RESERVED_EXPORTER_LABELS: ReadonlySet<string> = new Set([
  'client finished',
  'server finished',
  'master secret',
  'key expansion',
  'extended master secret',
]);

/**
 * RFC 5705 §4. A `null` context and an empty one are different exporters: the empty one still
 * appends its zero length.
 */
export const tls12ExportKeyingMaterial = (
  suite: Tls12CipherSuite,
  masterSecret: Uint8Array,
  clientRandom: Uint8Array,
  serverRandom: Uint8Array,
  label: string,
  context: Uint8Array | null,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (RESERVED_EXPORTER_LABELS.has(label)) {
    throw new Error(`TLS 1.2 exporter label ${JSON.stringify(label)} is reserved by RFC 5705 §6`);
  }
  return tls12Prf(
    suite,
    masterSecret,
    label,
    context === null
      ? concat(clientRandom, serverRandom)
      : concat(clientRandom, serverRandom, writeUint16(context.length), context),
    length,
  );
};
