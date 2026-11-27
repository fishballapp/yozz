import { decodeDer, decodeInteger } from '@yozz.app/x509';
import { concat } from './bytes.ts';
import {
  type AlertDescription,
  type NamedGroup,
  SIGNATURE_SCHEMES,
  TLS_1_2_SIGNATURE_SCHEMES,
} from './wire.ts';

const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const parseOid = (bytes: Uint8Array): string => {
  if (bytes.length === 0) return '';
  const first = bytes[0];
  if (first === undefined) return '';
  const firstArc = Math.floor(first / 40);
  const secondArc = first % 40;
  const arcs = [firstArc, secondArc];
  let currentArc = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) break;
    currentArc = (currentArc << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      arcs.push(currentArc);
      currentArc = 0;
    }
  }
  return arcs.join('.');
};

/** RFC 9846 §4.5.2: an ECDSA scheme names its curve, and a mismatch is `illegal_parameter`, not a failed import. */
type SpkiAlgorithm = { readonly oid: string; readonly curveOid: string | undefined };

const SCHEME_CURVE_OIDS: Readonly<Record<number, string>> = {
  [SIGNATURE_SCHEMES.ecdsa_secp256r1_sha256]: '1.2.840.10045.3.1.7',
  [SIGNATURE_SCHEMES.ecdsa_secp384r1_sha384]: '1.3.132.0.34',
};

const getSpkiAlgorithm = (spkiDer: Uint8Array): SpkiAlgorithm | undefined => {
  try {
    const tree = decodeDer(spkiDer);
    if (tree.tagClass !== 'universal' || tree.tagNumber !== 16 || !tree.isConstructed) {
      return undefined;
    }
    const algId = tree.children[0];
    if (algId === undefined || algId.tagNumber !== 16 || !algId.isConstructed) {
      return undefined;
    }
    const oidNode = algId.children[0];
    if (oidNode === undefined || oidNode.tagNumber !== 6) {
      return undefined;
    }
    const parameters = algId.children[1];
    return {
      oid: parseOid(oidNode.content),
      curveOid:
        parameters !== undefined && parameters.tagNumber === 6
          ? parseOid(parameters.content)
          : undefined,
    };
  } catch {
    return undefined;
  }
};

const bigIntToBytes = (value: bigint, byteLength: number): Uint8Array<ArrayBuffer> => {
  if (value <= 0n || value >= 1n << BigInt(byteLength * 8)) {
    throw new Error('ECDSA signature scalar out of range');
  }
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

const derToP1363 = (derSignature: Uint8Array, scalarLength: number): Uint8Array<ArrayBuffer> => {
  const tree = decodeDer(derSignature);
  if (tree.tagClass !== 'universal' || tree.tagNumber !== 16 || !tree.isConstructed) {
    throw new Error('malformed ECDSA signature DER SEQUENCE');
  }
  if (tree.children.length !== 2) {
    throw new Error('ECDSA signature SEQUENCE must have exactly 2 integers');
  }
  const rNode = tree.children[0];
  const sNode = tree.children[1];
  if (rNode === undefined || sNode === undefined) {
    throw new Error('ECDSA signature missing r or s');
  }
  const rBigInt = decodeInteger(rNode);
  const sBigInt = decodeInteger(sNode);

  const rBytes = bigIntToBytes(rBigInt, scalarLength);
  const sBytes = bigIntToBytes(sBigInt, scalarLength);
  return concat(rBytes, sBytes);
};

export type ImportKeyResult =
  | { readonly ok: true; readonly key: CryptoKey }
  | { readonly ok: false; readonly description: AlertDescription };

export const importLeafKey = async (
  spkiDer: Uint8Array,
  scheme: number,
  algorithmOid?: string,
): Promise<ImportKeyResult> => {
  const algorithm = getSpkiAlgorithm(spkiDer);
  const oid = algorithmOid ?? algorithm?.oid;
  if (oid === undefined) {
    return { ok: false, description: 'bad_certificate' };
  }

  // §4.3.3: `rsa_pss_rsae_*` keys carry OID rsaEncryption; an id-RSASSA-PSS key belongs to
  // `rsa_pss_pss_*`, which is not offered.
  const requiredCurveOid = SCHEME_CURVE_OIDS[scheme];
  if (
    requiredCurveOid !== undefined &&
    algorithm !== undefined &&
    algorithm.curveOid !== requiredCurveOid
  ) {
    return { ok: false, description: 'illegal_parameter' };
  }

  try {
    switch (scheme) {
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha256: {
        if (oid !== '1.2.840.113549.1.1.1') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'RSA-PSS', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha384: {
        if (oid !== '1.2.840.113549.1.1.1') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'RSA-PSS', hash: 'SHA-384' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha512: {
        if (oid !== '1.2.840.113549.1.1.1') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'RSA-PSS', hash: 'SHA-512' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      case SIGNATURE_SCHEMES.ecdsa_secp256r1_sha256: {
        if (oid !== '1.2.840.10045.2.1') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      case SIGNATURE_SCHEMES.ecdsa_secp384r1_sha384: {
        if (oid !== '1.2.840.10045.2.1') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'ECDSA', namedCurve: 'P-384' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      case SIGNATURE_SCHEMES.ed25519: {
        if (oid !== '1.3.101.112') {
          return { ok: false, description: 'illegal_parameter' };
        }
        const key = await crypto.subtle.importKey(
          'spki',
          nonShared(spkiDer),
          { name: 'Ed25519' },
          false,
          ['verify'],
        );
        return { ok: true, key };
      }
      default:
        return { ok: false, description: 'illegal_parameter' };
    }
  } catch {
    return { ok: false, description: 'bad_certificate' };
  }
};

export type VerifyCertificateVerifyOptions = {
  readonly scheme: number;
  readonly signature: Uint8Array;
  readonly spkiDer: Uint8Array;
  readonly algorithmOid?: string;
  readonly transcriptHash: Uint8Array;
};

export type VerifyCertificateVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly description: AlertDescription };

export const verifyCertificateVerify = async (
  options: VerifyCertificateVerifyOptions,
): Promise<VerifyCertificateVerifyResult> => {
  const keyRes = await importLeafKey(options.spkiDer, options.scheme, options.algorithmOid);
  if (!keyRes.ok) return keyRes;

  const prefix = new Uint8Array(64).fill(0x20);
  const context = new TextEncoder().encode('TLS 1.3, server CertificateVerify');
  const signedData = concat(prefix, context, Uint8Array.of(0x00), options.transcriptHash);

  let isValid = false;
  try {
    switch (options.scheme) {
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha256: {
        isValid = await crypto.subtle.verify(
          { name: 'RSA-PSS', saltLength: 32 },
          keyRes.key,
          nonShared(options.signature),
          nonShared(signedData),
        );
        break;
      }
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha384: {
        isValid = await crypto.subtle.verify(
          { name: 'RSA-PSS', saltLength: 48 },
          keyRes.key,
          nonShared(options.signature),
          nonShared(signedData),
        );
        break;
      }
      case SIGNATURE_SCHEMES.rsa_pss_rsae_sha512: {
        isValid = await crypto.subtle.verify(
          { name: 'RSA-PSS', saltLength: 64 },
          keyRes.key,
          nonShared(options.signature),
          nonShared(signedData),
        );
        break;
      }
      case SIGNATURE_SCHEMES.ecdsa_secp256r1_sha256: {
        const p1363Sig = derToP1363(options.signature, 32);
        isValid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyRes.key,
          nonShared(p1363Sig),
          nonShared(signedData),
        );
        break;
      }
      case SIGNATURE_SCHEMES.ecdsa_secp384r1_sha384: {
        const p1363Sig = derToP1363(options.signature, 48);
        isValid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-384' },
          keyRes.key,
          nonShared(p1363Sig),
          nonShared(signedData),
        );
        break;
      }
      case SIGNATURE_SCHEMES.ed25519: {
        isValid = await crypto.subtle.verify(
          { name: 'Ed25519' },
          keyRes.key,
          nonShared(options.signature),
          nonShared(signedData),
        );
        break;
      }
      default:
        return { ok: false, description: 'illegal_parameter' };
    }
  } catch {
    return { ok: false, description: 'decrypt_error' };
  }

  if (!isValid) {
    return { ok: false, description: 'decrypt_error' };
  }

  return { ok: true };
};

export type VerifyServerKeyExchangeOptions = {
  readonly scheme: number;
  readonly signature: Uint8Array;
  readonly spkiDer: Uint8Array;
  readonly algorithmOid?: string;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  /** The `ServerECDHParams` exactly as received: curve type, named curve, public point. */
  readonly serverParams: Uint8Array;
};

const RSA_ENCRYPTION_OID = '1.2.840.113549.1.1.1';
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const ED25519_OID = '1.3.101.112';

/** The curves an ECDSA ServerKeyExchange key may sit on, with each one's scalar length. */
const TLS_1_2_ECDSA_CURVES: Readonly<
  Record<
    string,
    {
      readonly group: NamedGroup;
      readonly namedCurve: 'P-256' | 'P-384';
      readonly scalarLength: 32 | 48;
    }
  >
> = {
  '1.2.840.10045.3.1.7': { group: 'secp256r1', namedCurve: 'P-256', scalarLength: 32 },
  '1.3.132.0.34': { group: 'secp384r1', namedCurve: 'P-384', scalarLength: 48 },
};

/** RFC 8422 §5.1.1: the TLS `NamedGroup` of an EC SPKI's curve, or `undefined` if unsupported. */
export const spkiEcNamedGroup = (spkiDer: Uint8Array): NamedGroup | undefined => {
  const algorithm = getSpkiAlgorithm(spkiDer);
  if (algorithm?.oid !== EC_PUBLIC_KEY_OID || algorithm.curveOid === undefined) {
    return undefined;
  }
  return TLS_1_2_ECDSA_CURVES[algorithm.curveOid]?.group;
};

/** How to verify each TLS 1.2 scheme. The ECDSA rows name a hash only (RFC 5246 §7.4.1.4.1). */
type Tls12Verifier =
  | {
      readonly family: 'rsa';
      readonly importParams: RsaHashedImportParams;
      readonly verifyParams: AlgorithmIdentifier | RsaPssParams;
    }
  | { readonly family: 'ecdsa'; readonly hash: 'SHA-256' | 'SHA-384' }
  | { readonly family: 'ed25519' };

const TLS_1_2_VERIFIERS: Readonly<Record<number, Tls12Verifier>> = {
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pss_rsae_sha256]: {
    family: 'rsa',
    importParams: { name: 'RSA-PSS', hash: 'SHA-256' },
    verifyParams: { name: 'RSA-PSS', saltLength: 32 },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pss_rsae_sha384]: {
    family: 'rsa',
    importParams: { name: 'RSA-PSS', hash: 'SHA-384' },
    verifyParams: { name: 'RSA-PSS', saltLength: 48 },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pss_rsae_sha512]: {
    family: 'rsa',
    importParams: { name: 'RSA-PSS', hash: 'SHA-512' },
    verifyParams: { name: 'RSA-PSS', saltLength: 64 },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pkcs1_sha256]: {
    family: 'rsa',
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pkcs1_sha384]: {
    family: 'rsa',
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.rsa_pkcs1_sha512]: {
    family: 'rsa',
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
  },
  [TLS_1_2_SIGNATURE_SCHEMES.ecdsa_secp256r1_sha256]: { family: 'ecdsa', hash: 'SHA-256' },
  [TLS_1_2_SIGNATURE_SCHEMES.ecdsa_secp384r1_sha384]: { family: 'ecdsa', hash: 'SHA-384' },
  [TLS_1_2_SIGNATURE_SCHEMES.ed25519]: { family: 'ed25519' },
};

type PreparedVerification = {
  readonly key: CryptoKey;
  readonly params: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  readonly ecdsaScalarLength: number | null;
};

const prepareTls12Verification = async (
  verifier: Tls12Verifier,
  spkiDer: Uint8Array,
  algorithm: SpkiAlgorithm,
): Promise<PreparedVerification | null> => {
  const importVerifyKey = (
    params: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams,
  ) => crypto.subtle.importKey('spki', nonShared(spkiDer), params, false, ['verify']);

  if (verifier.family === 'rsa') {
    if (algorithm.oid !== RSA_ENCRYPTION_OID) return null;
    return {
      key: await importVerifyKey(verifier.importParams),
      params: verifier.verifyParams,
      ecdsaScalarLength: null,
    };
  }
  if (verifier.family === 'ed25519') {
    if (algorithm.oid !== ED25519_OID) return null;
    return {
      key: await importVerifyKey({ name: 'Ed25519' }),
      params: { name: 'Ed25519' },
      ecdsaScalarLength: null,
    };
  }
  const curve =
    algorithm.curveOid === undefined ? undefined : TLS_1_2_ECDSA_CURVES[algorithm.curveOid];
  if (algorithm.oid !== EC_PUBLIC_KEY_OID || curve === undefined) return null;
  return {
    key: await importVerifyKey({ name: 'ECDSA', namedCurve: curve.namedCurve }),
    params: { name: 'ECDSA', hash: verifier.hash },
    ecdsaScalarLength: curve.scalarLength,
  };
};

/**
 * RFC 5246 §7.4.3 / RFC 8422 §5.4: the signature over `client_random || server_random ||
 * ServerECDHParams`. Unlike `verifyCertificateVerify`, RSA-PKCS1 is allowed and an ECDSA scheme
 * does not fix the key's curve; neither relaxation may reach TLS 1.3.
 */
export const verifyServerKeyExchange = async (
  options: VerifyServerKeyExchangeOptions,
): Promise<VerifyCertificateVerifyResult> => {
  const verifier = TLS_1_2_VERIFIERS[options.scheme];
  if (verifier === undefined) {
    return { ok: false, description: 'illegal_parameter' };
  }
  const parsed = getSpkiAlgorithm(options.spkiDer);
  if (parsed === undefined) {
    return { ok: false, description: 'bad_certificate' };
  }
  const algorithm = { oid: options.algorithmOid ?? parsed.oid, curveOid: parsed.curveOid };

  const prepared = await (async () => {
    try {
      return await prepareTls12Verification(verifier, options.spkiDer, algorithm);
    } catch {
      return 'unimportable' as const;
    }
  })();
  if (prepared === 'unimportable') {
    return { ok: false, description: 'bad_certificate' };
  }
  if (prepared === null) {
    return { ok: false, description: 'illegal_parameter' };
  }

  const signedData = concat(options.clientRandom, options.serverRandom, options.serverParams);
  const isValid = await (async () => {
    try {
      const signature =
        prepared.ecdsaScalarLength === null
          ? options.signature
          : derToP1363(options.signature, prepared.ecdsaScalarLength);
      return await crypto.subtle.verify(
        prepared.params,
        prepared.key,
        nonShared(signature),
        nonShared(signedData),
      );
    } catch {
      return false;
    }
  })();

  return isValid ? { ok: true } : { ok: false, description: 'decrypt_error' };
};
