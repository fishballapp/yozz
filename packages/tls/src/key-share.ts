/**
 * TLS 1.3 Key Share and Diffie-Hellman Key Exchange (RFC 9846 §4.3.8) over WebCrypto.
 * Supports X25519, secp256r1 (P-256), and secp384r1 (P-384).
 */

import { concat } from './bytes.ts';
import type { NamedGroup } from './wire.ts';

const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b !== undefined) binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const fromBase64Url = (b64url: string): Uint8Array<ArrayBuffer> => {
  let b64 = b64url.replaceAll('-', '+').replaceAll('_', '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

const modInverse = (k: bigint, m: bigint): bigint => {
  let [a, b] = [k, m];
  let [x0, x1] = [0n, 1n];
  if (m === 1n) return 0n;
  while (a > 1n) {
    const q = a / b;
    [a, b] = [b, a % b];
    [x0, x1] = [x1 - q * x0, x0];
  }
  if (x1 < 0n) x1 += m;
  return x1;
};

type JacobianPoint = readonly [bigint, bigint, bigint];

const jacobianAdd = (
  p1: JacobianPoint | null,
  p2: JacobianPoint | null,
  p: bigint,
): JacobianPoint | null => {
  if (p1 === null) return p2;
  if (p2 === null) return p1;
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  const z1z1 = mod(z1 * z1, p);
  const z2z2 = mod(z2 * z2, p);
  const u1 = mod(x1 * z2z2, p);
  const u2 = mod(x2 * z1z1, p);
  const s1 = mod(y1 * z2 * z2z2, p);
  const s2 = mod(y2 * z1 * z1z1, p);
  if (u1 === u2) {
    if (s1 === s2) return jacobianDouble(p1, p);
    return null;
  }
  const h = mod(u2 - u1, p);
  const i = mod(4n * h * h, p);
  const j = mod(h * i, p);
  const r = mod(2n * (s2 - s1), p);
  const v = mod(u1 * i, p);
  const x3 = mod(r * r - j - 2n * v, p);
  const y3 = mod(r * (v - x3) - 2n * s1 * j, p);
  const z3 = mod(mod((z1 + z2) * (z1 + z2) - z1z1 - z2z2, p) * h, p);
  return [x3, y3, z3];
};

const jacobianDouble = (p1: JacobianPoint | null, p: bigint): JacobianPoint | null => {
  if (p1 === null) return null;
  const [x1, y1, z1] = p1;
  const a = mod(x1 * x1, p);
  const b = mod(y1 * y1, p);
  const c = mod(b * b, p);
  const d = mod(2n * (mod((x1 + b) * (x1 + b), p) - a - c), p);
  const z1z1 = mod(z1 * z1, p);
  const e = mod(3n * (x1 - z1z1) * (x1 + z1z1), p);
  const f = mod(e * e - 2n * d, p);
  const x3 = f;
  const y3 = mod(e * (d - f) - 8n * c, p);
  const z3 = mod(2n * y1 * z1, p);
  return [x3, y3, z3];
};

const ecScalarMult = (
  k: bigint,
  generator: readonly [bigint, bigint],
  p: bigint,
): readonly [bigint, bigint] => {
  const [gx, gy] = generator;
  const pJac: JacobianPoint = [gx, gy, 1n];
  let rJac: JacobianPoint | null = null;
  let curr: JacobianPoint | null = pJac;
  let scalar = k;

  while (scalar > 0n) {
    if (scalar & 1n) {
      rJac = jacobianAdd(rJac, curr, p);
    }
    curr = jacobianDouble(curr, p);
    scalar >>= 1n;
  }

  if (rJac === null) {
    throw new Error('Scalar multiplication resulted in point at infinity');
  }

  const [rx, ry, rz] = rJac;
  const zInv = modInverse(rz, p);
  const zInv2 = mod(zInv * zInv, p);
  const zInv3 = mod(zInv2 * zInv, p);
  return [mod(rx * zInv2, p), mod(ry * zInv3, p)];
};

const P256 = {
  p: 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n,
  G: [
    0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  ] as const,
};

const P384 = {
  p: 2n ** 384n - 2n ** 128n - 2n ** 96n + 2n ** 32n - 1n,
  G: [
    0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
  ] as const,
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b !== undefined) hex += b.toString(16).padStart(2, '0');
  }
  return BigInt(`0x${hex}`);
};

const bigIntToBytes = (value: bigint, byteLength: number): Uint8Array<ArrayBuffer> => {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const targetHex = hex.padStart(byteLength * 2, '0');
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    const byteHex = targetHex.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(byteHex, 16);
  }
  return bytes;
};

export type KeySharePair = {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
};

/** The generation parameters per group, so the switch below has one arm to read. */
const GENERATION_ALGORITHMS: Readonly<Record<NamedGroup, EcKeyGenParams | Algorithm>> = {
  x25519: { name: 'X25519' },
  secp256r1: { name: 'ECDH', namedCurve: 'P-256' },
  secp384r1: { name: 'ECDH', namedCurve: 'P-384' },
};

export const generateKeyShare = async (group: NamedGroup): Promise<KeySharePair> => {
  // `generateKey` is typed `CryptoKey | CryptoKeyPair` because one signature
  // covers symmetric algorithms too. Asserting the union away with `as` would be
  // a compile-time claim about a runtime value, which is what the repo's rule
  // against `!` and `as` exists to stop. Narrow it, and say so if it is wrong.
  const generated = await crypto.subtle.generateKey(GENERATION_ALGORITHMS[group], true, [
    'deriveBits',
  ]);
  if (!('privateKey' in generated)) {
    throw new Error(`WebCrypto returned a single key for ${group}, not a pair`);
  }
  return {
    privateKey: generated.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey)),
  };
};

export const importPrivateShare = async (
  group: NamedGroup,
  privateKeyBytes: Uint8Array,
): Promise<KeySharePair> => {
  switch (group) {
    case 'x25519': {
      const pkcs8Prefix = Uint8Array.of(
        0x30,
        0x2e,
        0x02,
        0x01,
        0x00,
        0x30,
        0x05,
        0x06,
        0x03,
        0x2b,
        0x65,
        0x6e,
        0x04,
        0x22,
        0x04,
        0x20,
      );
      const pkcs8 = concat(pkcs8Prefix, privateKeyBytes);
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        nonShared(pkcs8),
        { name: 'X25519' },
        true,
        ['deriveBits'],
      );
      const jwk = await crypto.subtle.exportKey('jwk', privateKey);
      if (jwk.x === undefined) {
        throw new Error('Failed to export X25519 public key from private key');
      }
      const publicKey = fromBase64Url(jwk.x);
      return { privateKey, publicKey };
    }

    case 'secp256r1': {
      const d = bytesToBigInt(privateKeyBytes);
      const [x, y] = ecScalarMult(d, P256.G, P256.p);
      const xBytes = bigIntToBytes(x, 32);
      const yBytes = bigIntToBytes(y, 32);
      const publicKey = concat(Uint8Array.of(0x04), xBytes, yBytes);

      const jwk: JsonWebKey = {
        kty: 'EC',
        crv: 'P-256',
        d: toBase64Url(privateKeyBytes),
        x: toBase64Url(xBytes),
        y: toBase64Url(yBytes),
        ext: true,
      };

      const privateKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      return { privateKey, publicKey };
    }

    case 'secp384r1': {
      const d = bytesToBigInt(privateKeyBytes);
      const [x, y] = ecScalarMult(d, P384.G, P384.p);
      const xBytes = bigIntToBytes(x, 48);
      const yBytes = bigIntToBytes(y, 48);
      const publicKey = concat(Uint8Array.of(0x04), xBytes, yBytes);

      const jwk: JsonWebKey = {
        kty: 'EC',
        crv: 'P-384',
        d: toBase64Url(privateKeyBytes),
        x: toBase64Url(xBytes),
        y: toBase64Url(yBytes),
        ext: true,
      };

      const privateKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDH', namedCurve: 'P-384' },
        true,
        ['deriveBits'],
      );
      return { privateKey, publicKey };
    }
  }
};

export const deriveSharedSecret = async (
  group: NamedGroup,
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> => {
  switch (group) {
    case 'x25519': {
      const peerKey = await crypto.subtle.importKey(
        'raw',
        nonShared(peerPublicKeyBytes),
        { name: 'X25519' },
        false,
        [],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'X25519', public: peerKey },
        privateKey,
        256,
      );
      return new Uint8Array(bits);
    }
    case 'secp256r1': {
      const peerKey = await crypto.subtle.importKey(
        'raw',
        nonShared(peerPublicKeyBytes),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerKey },
        privateKey,
        256,
      );
      return new Uint8Array(bits);
    }
    case 'secp384r1': {
      const peerKey = await crypto.subtle.importKey(
        'raw',
        nonShared(peerPublicKeyBytes),
        { name: 'ECDH', namedCurve: 'P-384' },
        false,
        [],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerKey },
        privateKey,
        384,
      );
      return new Uint8Array(bits);
    }
  }
};
