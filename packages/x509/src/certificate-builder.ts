/**
 * Builds REAL, SIGNED certificates, so the validator can be tested end to end
 * without the 39MB x509-limbo cache.
 *
 * This exists because of a measured failure: `pnpm test` had no coverage of
 * `validate.ts` at all, and two authentication bypasses passed every green gate.
 * The limbo suite is the exhaustive gate and it cannot run in CI; this is the
 * one that always runs.
 *
 * Test support. It is NOT exported from `index.ts`, nothing in the validation
 * path imports it, and it never reaches a browser.
 */
import { decodeCertificate } from './certificate.ts';

const encodeLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    octets.unshift(remaining % 256);
  }
  return [0x80 | octets.length, ...octets];
};

const tlv = (tag: number, ...content: readonly Uint8Array[]): Uint8Array => {
  const body = content.flatMap(part => [...part]);
  return Uint8Array.from([tag, ...encodeLength(body.length), ...body]);
};

const sequence = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x30, ...content);
const set = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x31, ...content);
const explicit = (tagNumber: number, ...content: readonly Uint8Array[]): Uint8Array =>
  tlv(0xa0 | tagNumber, ...content);
const ascii = (tag: number, text: string): Uint8Array =>
  tlv(tag, Uint8Array.from([...text].map(character => character.charCodeAt(0))));
const octetString = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);
const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, Uint8Array.from([0, ...bytes]));
const asBoolean = (value: boolean): Uint8Array => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));

const oid = (dotted: string): Uint8Array => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const base128 = (value: number): number[] => {
    const digits = [value % 128];
    for (let n = Math.floor(value / 128); n > 0; n = Math.floor(n / 128)) {
      digits.unshift((n % 128) | 0x80);
    }
    return digits;
  };
  return tlv(0x06, Uint8Array.from([first * 40 + second, ...rest.flatMap(base128)]));
};

/** Minimal two's complement, which is what DER wants and what our decoder checks. */
const integer = (bytes: Uint8Array): Uint8Array => {
  const firstMeaningful = bytes.findIndex(byte => byte !== 0);
  const trimmed = firstMeaningful === -1 ? Uint8Array.of(0) : bytes.subarray(firstMeaningful);
  const isNegativeLooking = ((trimmed[0] ?? 0) & 0x80) !== 0;
  return tlv(0x02, isNegativeLooking ? Uint8Array.from([0, ...trimmed]) : trimmed);
};

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
const COMMON_NAME = '2.5.4.3';
export const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const distinguishedName = (commonName: string): Uint8Array =>
  sequence(set(sequence(oid(COMMON_NAME), ascii(0x13, commonName))));

/** RFC 5280 UTCTime: two-digit year, seconds mandatory, Z only. */
const utcTime = (when: Date): Uint8Array => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const text =
    pad(when.getUTCFullYear() % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    'Z';
  return ascii(0x17, text);
};

const extension = (extnOid: string, value: Uint8Array, isCritical = false): Uint8Array =>
  sequence(oid(extnOid), ...(isCritical ? [asBoolean(true)] : []), octetString(value));

/** ECDSA signs to fixed-width `r || s`; a certificate carries DER `SEQUENCE { r, s }`. */
const derFromP1363 = (signature: Uint8Array): Uint8Array => {
  const half = signature.length / 2;
  return sequence(integer(signature.subarray(0, half)), integer(signature.subarray(half)));
};

/** WebCrypto's types want a buffer proven not to be shared; a copy proves it. */
const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const keyIdentifierOf = async (spki: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', nonShared(spki))).subarray(0, 20);

export type IssuedCertificate = {
  readonly der: Uint8Array;
  /**
   * The key this certificate attests to — BOTH halves, so a caller can hand the
   * pair back as `keyPair` and get a second certificate over the same key.
   */
  readonly keyPair: CryptoKeyPair;
  readonly subjectKeyIdentifier: Uint8Array;
  readonly subjectDer: Uint8Array;
};

export type IssueOptions = {
  readonly commonName: string;
  /** Omitted means self-signed, which is how a root is made. */
  readonly issuer?: IssuedCertificate;
  readonly isCa?: boolean;
  readonly pathLength?: number;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  readonly dnsNames?: readonly string[];
  /** OIDs. A leaf needs `SERVER_AUTH` to be usable; a root must state none. */
  readonly extendedKeyUsages?: readonly string[];
  readonly permittedDnsNames?: readonly string[];
  readonly excludedDnsNames?: readonly string[];
  /** Signs with a key that is not the issuer's, to produce a bad signature. */
  readonly signWith?: CryptoKey;
  /**
   * Issue over an existing key instead of a fresh one — a REISSUE, which is what
   * a certificate renewal is and what an SPKI pin has to stay silent through.
   * Without it every certificate this builder makes carries a new key, so a rig
   * cannot tell "the host renewed" from "the host rotated its key" and the two
   * halves of the pin gate collapse into one.
   */
  readonly keyPair?: CryptoKeyPair;
};

const YEAR = 365 * 24 * 60 * 60 * 1000;

export const issueCertificate = async ({
  commonName,
  issuer,
  isCa = false,
  pathLength,
  notBefore = new Date(Date.now() - YEAR),
  notAfter = new Date(Date.now() + YEAR),
  dnsNames = [],
  extendedKeyUsages = [],
  permittedDnsNames,
  excludedDnsNames,
  signWith,
  keyPair,
}: IssueOptions): Promise<IssuedCertificate> => {
  const pair =
    keyPair ??
    (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const subjectKeyIdentifier = await keyIdentifierOf(spki);
  const subjectDer = distinguishedName(commonName);
  const issuerDer = issuer === undefined ? subjectDer : issuer.subjectDer;

  const generalNames = (names: readonly string[]): Uint8Array =>
    sequence(...names.map(name => ascii(0x82, name)));
  const subtrees = (tagNumber: number, names: readonly string[]): Uint8Array =>
    explicit(tagNumber, ...names.map(name => sequence(ascii(0x82, name))));

  const extensions = [
    ...(isCa
      ? [
          extension(
            '2.5.29.19',
            sequence(
              asBoolean(true),
              ...(pathLength === undefined ? [] : [integer(Uint8Array.of(pathLength))]),
            ),
            true,
          ),
          // keyCertSign, bit 5 of the first octet.
          extension('2.5.29.15', tlv(0x03, Uint8Array.of(1, 0x04)), true),
        ]
      : []),
    extension('2.5.29.14', octetString(subjectKeyIdentifier)),
    ...(issuer === undefined
      ? []
      : [extension('2.5.29.35', sequence(tlv(0x80, issuer.subjectKeyIdentifier)))]),
    ...(dnsNames.length === 0 ? [] : [extension('2.5.29.17', generalNames(dnsNames))]),
    ...(extendedKeyUsages.length === 0
      ? []
      : [extension('2.5.29.37', sequence(...extendedKeyUsages.map(oid)))]),
    ...(permittedDnsNames === undefined && excludedDnsNames === undefined
      ? []
      : [
          extension(
            '2.5.29.30',
            sequence(
              ...(permittedDnsNames === undefined ? [] : [subtrees(0, permittedDnsNames)]),
              ...(excludedDnsNames === undefined ? [] : [subtrees(1, excludedDnsNames)]),
            ),
            true,
          ),
        ]),
  ];

  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] ?? 1) & 0x7f || 1;
  const tbsCertificate = sequence(
    explicit(0, tlv(0x02, Uint8Array.of(2))),
    integer(serial),
    ECDSA_WITH_SHA256,
    issuerDer,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subjectDer,
    spki,
    explicit(3, sequence(...extensions)),
  );

  const signingKey = signWith ?? issuer?.keyPair.privateKey ?? pair.privateKey;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      nonShared(tbsCertificate),
    ),
  );
  const der = sequence(tbsCertificate, ECDSA_WITH_SHA256, bitString(derFromP1363(signature)));

  // Fails loudly here rather than as a mysterious rejection inside a test.
  decodeCertificate(der);
  return { der, keyPair: pair, subjectKeyIdentifier, subjectDer };
};
