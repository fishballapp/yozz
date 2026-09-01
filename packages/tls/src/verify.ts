import { decodeDer, decodeInteger } from '@yozz.app/x509';
import { concat } from './bytes.ts';
import { type AlertDescription, SIGNATURE_SCHEMES } from './wire.ts';

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
