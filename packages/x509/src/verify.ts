/**
 * Signature verification, and the key-strength policy WebPKI adds on top of RFC
 * 5280.
 *
 * The algorithm table is bounded by measurement, not by RFC 5280's full menu:
 * across x509-limbo's 30340 certificates and the 59 harvested from real mail
 * servers and root stores, exactly six signature algorithms and two key types
 * appear. Everything else — SHA-1, DSA, ML-DSA — is refused, which is also the
 * right answer for a browser-facing client in 2026.
 *
 * WebCrypto is ASYNC and `rustls-webpki` is not, which is the one thing that
 * blocked the rustls hybrid. Here it costs nothing: the validator contract
 * already returns a promise.
 */

import type { AlgorithmIdentifier, SubjectPublicKeyInfo } from './certificate.ts';
import { decodeDer, decodeInteger } from './der.ts';

/** OID -> how WebCrypto is asked to verify it. Absent means refused. */
const SIGNATURE_ALGORITHMS: Readonly<
  Record<string, { readonly name: 'RSASSA-PKCS1-v1_5' | 'ECDSA'; readonly hash: string }>
> = {
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' },
};

const RSA_OID = '1.2.840.113549.1.1.1';
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';

/**
 * The curves WebPKI permits, with the width one half of an ECDSA signature takes
 * in P1363 form. P-192 is deliberately absent: x509-limbo has a case for it, and
 * "the curve is too small" must be a refusal rather than a verification failure.
 */
const CURVES: Readonly<
  Record<string, { readonly namedCurve: string; readonly halfWidth: number }>
> = {
  '1.2.840.10045.3.1.7': { namedCurve: 'P-256', halfWidth: 32 },
  '1.3.132.0.34': { namedCurve: 'P-384', halfWidth: 48 },
  '1.3.132.0.35': { namedCurve: 'P-521', halfWidth: 66 },
};

/**
 * The two tables above, as the only thing outside this package that may read
 * them: which certificate signature algorithms this validator will verify, and
 * over which curves, **named by OID** because an OID is a certificate's own
 * vocabulary and this package must never learn TLS's.
 *
 * They exist because `@yozz.app/tls` has to answer a question only these tables
 * know: RFC 9846 §4.3.3's `signature_algorithms_cert`, which tells a server
 * which certificate signatures a client can verify. Restating the answer over
 * there is how the two came to disagree — the ClientHello advertised RSA-PSS
 * and Ed25519, which are absent below, and never advertised RSA-PKCS1, which
 * signs most of the real WebPKI. **A list in two files is the bug**, so there
 * is one list and the other side maps it.
 *
 * A caller that maps fewer of these than exist is safe: it under-advertises,
 * and a server that finds no match sends its chain anyway (§4.5.1.2). A caller
 * that maps MORE is the failure this replaced, so `@yozz.app/tls` has a test that
 * fails when a name here has no code point over there.
 */
export const CERTIFICATE_SIGNATURE_ALGORITHM_OIDS: readonly string[] =
  Object.keys(SIGNATURE_ALGORITHMS);

/** The same, for the curves an ECDSA certificate key may be on. */
export const CERTIFICATE_CURVE_OIDS: readonly string[] = Object.keys(CURVES);

/** RFC 5280 sets no floor; the CA/Browser Forum does, and every browser enforces it. */
const MINIMUM_RSA_MODULUS_BITS = 2048;

/**
 * ECDSA signatures are DER `SEQUENCE { r INTEGER, s INTEGER }` in a certificate
 * and fixed-width `r || s` in WebCrypto. Going through bigint rather than
 * slicing bytes means DER's own minimality rules are enforced on the way — a
 * signature with a padded `r` is re-encoded by nobody, it is rejected.
 */
const p1363FromDer = (signature: Uint8Array, halfWidth: number): Uint8Array | null => {
  const sequence = decodeDer(signature);
  if (!sequence.isConstructed || sequence.children.length !== 2) return null;
  const [r, s] = sequence.children;
  if (r === undefined || s === undefined) return null;

  const fixedWidth = (value: bigint): Uint8Array | null => {
    if (value < 0n) return null;
    const octets = new Uint8Array(halfWidth);
    let remaining = value;
    for (let index = halfWidth - 1; index >= 0; index -= 1) {
      octets[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return remaining === 0n ? octets : null;
  };

  const encodedR = fixedWidth(decodeInteger(r));
  const encodedS = fixedWidth(decodeInteger(s));
  if (encodedR === null || encodedS === null) return null;
  return Uint8Array.from([...encodedR, ...encodedS]);
};

/** Bit length of the RSA modulus, read out of the SPKI's own RSAPublicKey. */
const rsaModulusBits = (subjectPublicKey: Uint8Array): number | null => {
  // Total by construction. `rejectKey` is called on attacker-chosen keys from
  // outside any catch, so a key that is not even DER has to read as "unusable"
  // rather than as a thrown promise.
  try {
    const sequence = decodeDer(subjectPublicKey);
    if (!sequence.isConstructed) return null;
    const [modulus] = sequence.children;
    if (modulus === undefined) return null;
    const value = decodeInteger(modulus);
    return value <= 0n ? null : value.toString(2).length;
  } catch {
    return null;
  }
};

export type KeyRejection = 'unsupported' | 'too-weak';

/**
 * WebPKI's key policy, applied to the SPKI as decoded. Returns null when the key
 * is acceptable — a rejection here is about the KEY, and stays distinct from a
 * signature that simply does not verify.
 */
export const rejectKey = (spki: SubjectPublicKeyInfo): KeyRejection | null => {
  if (spki.algorithm.oid === EC_PUBLIC_KEY_OID) {
    const curveOid =
      spki.algorithm.parametersDer === null ? null : readOidBytes(spki.algorithm.parametersDer);
    if (curveOid === null) return 'unsupported';
    return CURVES[curveOid] === undefined ? 'too-weak' : null;
  }
  if (spki.algorithm.oid === RSA_OID) {
    const bits = rsaModulusBits(spki.subjectPublicKey);
    if (bits === null) return 'unsupported';
    // A modulus that is not a whole number of octets is malformed in practice
    // and x509-limbo has a case for it.
    return bits < MINIMUM_RSA_MODULUS_BITS || bits % 8 !== 0 ? 'too-weak' : null;
  }
  return 'unsupported';
};

const readOidBytes = (der: Uint8Array): string | null => {
  try {
    const node = decodeDer(der);
    if (node.tagClass !== 'universal' || node.tagNumber !== 6) return null;
    return decodeOidOf(node.content);
  } catch {
    return null;
  }
};

/** The named-curve parameter is one OID; decode it from content rather than re-tagging a node. */
const decodeOidOf = (content: Uint8Array): string | null => {
  const arcs: bigint[] = [];
  let value = 0n;
  let isStart = true;
  for (const octet of content) {
    if (isStart && octet === 0x80) return null;
    value = (value << 7n) | BigInt(octet & 0x7f);
    const isLast = (octet & 0x80) === 0;
    if (isLast) {
      arcs.push(value);
      value = 0n;
    }
    isStart = isLast;
  }
  const [first, ...rest] = arcs;
  if (!isStart || first === undefined) return null;
  const firstArc = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [firstArc, first - firstArc * 40n, ...rest].join('.');
};

/**
 * WebCrypto's TypeScript types demand a buffer proven not to be shared, which a
 * view into a caller's array cannot prove. Copying at this boundary — a few KB
 * per verification, against a public-key operation — is cheaper than widening
 * the frozen validator contract's byte types to say so.
 */
const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export type SignatureVerdict = 'valid' | 'invalid' | 'unsupported-algorithm' | 'unusable-key';

/**
 * Verifies `signedDer` against `signature` using the issuer's key. Never throws
 * on attacker input: an unparseable signature is `invalid`, which is the same
 * outcome as a wrong one and keeps the caller's branching honest.
 */
export const verifySignature = async ({
  signedDer,
  signature,
  algorithm,
  issuerKey,
}: {
  signedDer: Uint8Array;
  signature: Uint8Array;
  algorithm: AlgorithmIdentifier;
  issuerKey: SubjectPublicKeyInfo;
}): Promise<SignatureVerdict> => {
  const parameters = SIGNATURE_ALGORITHMS[algorithm.oid];
  if (parameters === undefined) return 'unsupported-algorithm';
  if (rejectKey(issuerKey) !== null) return 'unusable-key';

  const curveOid =
    issuerKey.algorithm.parametersDer === null
      ? null
      : readOidBytes(issuerKey.algorithm.parametersDer);
  const curve = curveOid === null ? undefined : CURVES[curveOid];

  // The signature algorithm and the key must be the same family. Verifying an
  // ECDSA signature against an RSA key is not a failed check, it is a category
  // error, and WebCrypto would report it as a thrown DataError.
  const isEcdsa = parameters.name === 'ECDSA';
  if (isEcdsa !== (issuerKey.algorithm.oid === EC_PUBLIC_KEY_OID)) return 'invalid';
  if (isEcdsa && curve === undefined) return 'unusable-key';

  return await (async (): Promise<SignatureVerdict> => {
    try {
      const key = await crypto.subtle.importKey(
        'spki',
        nonShared(issuerKey.der),
        isEcdsa
          ? { name: 'ECDSA', namedCurve: curve?.namedCurve ?? '' }
          : { name: 'RSASSA-PKCS1-v1_5', hash: parameters.hash },
        false,
        ['verify'],
      );
      const encoded = isEcdsa ? p1363FromDer(signature, curve?.halfWidth ?? 0) : signature;
      if (encoded === null) return 'invalid';
      const isValid = await crypto.subtle.verify(
        isEcdsa ? { name: 'ECDSA', hash: parameters.hash } : { name: 'RSASSA-PKCS1-v1_5' },
        key,
        nonShared(encoded),
        nonShared(signedDer),
      );
      return isValid ? 'valid' : 'invalid';
    } catch {
      // WebCrypto throws on a key it cannot import and on a malformed signature.
      // Both mean this certificate was not validly signed by this issuer.
      return 'invalid';
    }
  })();
};
