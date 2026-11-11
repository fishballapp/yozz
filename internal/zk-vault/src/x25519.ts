/** X25519 on WebCrypto: the pairs a CLI key and a sealed box are made of. */

import { concat, fromBase64, toBase64Url, VaultError } from './bytes.ts';

const X25519 = { name: 'X25519' } as const;

const KEY_BYTES = 32;

/** RFC 8410 §7: a PKCS #8 X25519 private key is these 16 bytes and then the 32-byte key. */
const PKCS8_PREFIX = Uint8Array.fromHex('302e020100300506032b656e04220420');

export type EncodedKeyPair = {
  /** Raw, base64url without padding. */
  readonly publicKey: string;
  /** PKCS #8, base64url without padding. */
  readonly privateKey: string;
};

export const decodePublicKey = (text: string, what: string): Uint8Array<ArrayBuffer> => {
  const bytes = fromBase64(text, what, 'base64url');
  if (bytes.length !== KEY_BYTES) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes, want ${KEY_BYTES}`);
  }
  return bytes;
};

export const exportPublicKey = async (key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.exportKey('raw', key));

/** The private half is extractable because its holder writes it to its own credentials. */
export const generateKeyPair = async (): Promise<EncodedKeyPair> => {
  const pair = await crypto.subtle.generateKey(X25519, true, ['deriveBits']);
  return {
    publicKey: toBase64Url(await exportPublicKey(pair.publicKey)),
    privateKey: toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    ),
  };
};

/** One the caller never sees the private half of. */
export const generateEphemeralKeyPair = async (): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array<ArrayBuffer>;
}> => {
  const pair = await crypto.subtle.generateKey(X25519, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: await exportPublicKey(pair.publicKey) };
};

export type PrivateKey = {
  readonly key: CryptoKey;
  /** Read back from the private key, never trusted beside it. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
};

const importPkcs8 = async (pkcs8: Uint8Array<ArrayBuffer>, what: string): Promise<PrivateKey> => {
  const key = await crypto.subtle
    .importKey('pkcs8', pkcs8, X25519, true, ['deriveBits'])
    .catch(() => {
      throw new VaultError('malformed', `${what} is not an X25519 PKCS #8 key`);
    });
  const { x } = await crypto.subtle.exportKey('jwk', key);
  if (x === undefined) throw new VaultError('malformed', `${what} has no public half`);
  return { key, publicKey: decodePublicKey(x, `${what}'s public half`) };
};

export const importPrivateKey = (privateKey: string, what: string): Promise<PrivateKey> =>
  importPkcs8(fromBase64(privateKey, what, 'base64url'), what);

/** RFC 7748 §5: any 32 bytes are a private key (the function clamps them), so a seed can be one. */
export const privateKeyFromBytes = async (bytes: Uint8Array, what: string): Promise<PrivateKey> => {
  if (bytes.length !== KEY_BYTES) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes, want ${KEY_BYTES}`);
  }
  return importPkcs8(concat(PKCS8_PREFIX, bytes), what);
};

export const agree = async (
  privateKey: CryptoKey,
  peerPublicKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> => {
  const peer = await crypto.subtle.importKey('raw', peerPublicKey, X25519, false, []);
  const shared = await crypto.subtle
    .deriveBits({ name: 'X25519', public: peer }, privateKey, 256)
    .catch(() => {
      // WebCrypto refuses an all-zero secret, which is what a low-order public key forces.
      throw new VaultError('malformed', 'the public key is not one X25519 can agree with');
    });
  return new Uint8Array(shared);
};

/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped has one spelling. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The first 40 bits of SHA-256(publicKey) as `XXXX-XXXX`: what two screens both show, so a person
 * can tell their own key from one a link someone else made carries.
 */
export const pairingCode = async (publicKey: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', decodePublicKey(publicKey, 'the public key')),
  );
  const bits = digest.subarray(0, 5).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const symbols = Array.from({ length: 8 }, (_, index) =>
    CROCKFORD.charAt(Number((bits >> BigInt(35 - 5 * index)) & 31n)),
  ).join('');
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
