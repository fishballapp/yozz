import type { AlgorithmIdentifier, SubjectPublicKeyInfo } from './certificate.ts';
import { decodeDer, decodeInteger } from './der.ts';

/** Absent means refused. Six algorithms and two key types cover every certificate in x509-limbo and the harvested corpus. */
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

/** With the width one half of an ECDSA signature takes in P1363 form. P-192 is absent on purpose. */
const CURVES: Readonly<
  Record<string, { readonly namedCurve: string; readonly halfWidth: number }>
> = {
  '1.2.840.10045.3.1.7': { namedCurve: 'P-256', halfWidth: 32 },
  '1.3.132.0.34': { namedCurve: 'P-384', halfWidth: 48 },
  '1.3.132.0.35': { namedCurve: 'P-521', halfWidth: 66 },
};

/** What `@yozz.app/tls` advertises as `signature_algorithms_cert` (RFC 9846 §4.3.3), so the two lists cannot disagree. */
export const CERTIFICATE_SIGNATURE_ALGORITHM_OIDS: readonly string[] =
  Object.keys(SIGNATURE_ALGORITHMS);

export const CERTIFICATE_CURVE_OIDS: readonly string[] = Object.keys(CURVES);

/** The CA/Browser Forum floor. */
const MINIMUM_RSA_MODULUS_BITS = 2048;

/** DER `SEQUENCE { r, s }` to WebCrypto's fixed-width `r || s`, via bigint so DER's minimality is enforced. */
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

const rsaModulusBits = (subjectPublicKey: Uint8Array): number | null => {
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

/** `null` when the key is acceptable. */
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
    // A modulus that is not a whole number of octets is malformed in practice.
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

/** WebCrypto's types want a buffer proven not to be shared, which a view cannot prove. */
const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export type SignatureVerdict = 'valid' | 'invalid' | 'unsupported-algorithm' | 'unusable-key';

/** Never throws on attacker input: an unparseable signature is `invalid`. */
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

  // WebCrypto throws a DataError on an ECDSA signature against an RSA key.
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
      return 'invalid';
    }
  })();
};
