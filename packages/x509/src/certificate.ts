/**
 * RFC 5280 certificate structure, decoded from the TLV tree `der.ts` produces.
 *
 * The split: this layer turns TLVs into typed fields and enforces the ENCODING
 * rules — inner and outer `AlgorithmIdentifier` agree, no extension OID appears
 * twice, extensions only where the version admits them. It decides nothing about
 * trust. Whether a `cA` bit is required, whether SHA-1 is acceptable, whether a
 * name matches: all M4.
 *
 * Every field an attacker controls is kept FAITHFULLY, not normalised. A dNSName
 * carrying an embedded NUL comes back with the NUL still in it, because
 * `evil.com\0.good.com` truncated at decode is how a name check gets fooled by a
 * string the CA never issued. Rejecting it is the matcher's job, and it can only
 * do that job if the bytes reach it intact.
 *
 * Failures throw `DerError`, the same type `der.ts` throws, so M4 still has
 * exactly one catch and `tls` still has one failure path.
 */
import {
  DerError,
  type DerNode,
  decodeBitString,
  decodeBoolean,
  decodeDer,
  decodeInteger,
  decodeOid,
  decodeTime,
} from './der.ts';

/** RFC 5280 s4.1.2.2. */
const MAXIMUM_SERIAL_OCTETS = 20;

const UNIVERSAL = { BIT_STRING: 3, OCTET_STRING: 4, OID: 6, SEQUENCE: 16, SET: 17 } as const;

const structure = (node: DerNode, detail: string): DerError =>
  new DerError('malformed-structure', node.offset, detail);

const expectUniversal = (node: DerNode, tagNumber: number, what: string): DerNode => {
  if (node.tagClass !== 'universal' || node.tagNumber !== tagNumber) {
    throw new DerError('unexpected-tag', node.offset, `expected ${what}`);
  }
  return node;
};

/**
 * An EXPLICIT tag wraps exactly ONE value. Taking the first child and ignoring
 * the rest lets a second, different value ride along invisibly, which is how two
 * implementations come to disagree about the same bytes.
 */
const onlyChildOf = (node: DerNode, what: string): DerNode => {
  const children = childrenOf(node, what);
  const [only] = children;
  if (only === undefined || children.length !== 1) {
    throw structure(node, `${what} wraps exactly one value, not ${children.length}`);
  }
  return only;
};

const childrenOf = (node: DerNode, what: string): readonly DerNode[] => {
  if (!node.isConstructed) throw structure(node, `${what} is constructed`);
  return node.children;
};

/**
 * Walks a SEQUENCE's fields in declaration order. OPTIONAL fields are why this
 * is a cursor and not destructuring: whether `issuerUniqueID` is present changes
 * which index `extensions` sits at.
 */
const fieldsOf = (node: DerNode, what: string) => {
  const children = childrenOf(node, what);
  let index = 0;
  return {
    next: (field: string): DerNode => {
      const child = children[index];
      if (child === undefined) throw structure(node, `${what} has no ${field}`);
      index += 1;
      return child;
    },
    peek: (): DerNode | undefined => children[index],
    skip: (): void => {
      index += 1;
    },
    assertExhausted: (): void => {
      if (index !== children.length) {
        throw structure(node, `${what} has ${children.length - index} unexpected trailing fields`);
      }
    },
  };
};

/** An OID plus its opaque parameters. RSASSA-PSS carries its entire configuration there. */
export type AlgorithmIdentifier = {
  readonly oid: string;
  /** The parameters TLV verbatim, or null when the field is absent (which differs from NULL). */
  readonly parametersDer: Uint8Array | null;
};

const decodeAlgorithmIdentifier = (node: DerNode): AlgorithmIdentifier => {
  const fields = fieldsOf(
    expectUniversal(node, UNIVERSAL.SEQUENCE, 'AlgorithmIdentifier'),
    'AlgorithmIdentifier',
  );
  const oid = decodeOid(fields.next('algorithm'));
  const parameters = fields.peek();
  if (parameters !== undefined) fields.skip();
  fields.assertExhausted();
  return { oid, parametersDer: parameters === undefined ? null : parameters.bytes };
};

const isSameAlgorithm = (a: AlgorithmIdentifier, b: AlgorithmIdentifier): boolean => {
  if (a.oid !== b.oid) return false;
  if (a.parametersDer === null || b.parametersDer === null) {
    return a.parametersDer === b.parametersDer;
  }
  if (a.parametersDer.length !== b.parametersDer.length) return false;
  return a.parametersDer.every((byte, index) => byte === b.parametersDer?.[index]);
};

export type AttributeTypeAndValue = {
  readonly oid: string;
  /**
   * The value TLV verbatim, string type included. `openssl x509 -text` shows the
   * text and hides whether it was a PrintableString or a UTF8String — and RFC
   * 5280 name comparison turns on exactly that, so the bytes are what we keep.
   */
  readonly valueDer: Uint8Array;
};

/** RDNSequence. The inner array is one RDN, which is a SET and may hold several attributes. */
export type Name = {
  readonly der: Uint8Array;
  readonly relativeDistinguishedNames: readonly (readonly AttributeTypeAndValue[])[];
};

const decodeName = (node: DerNode): Name => {
  const rdnSequence = expectUniversal(node, UNIVERSAL.SEQUENCE, 'Name');
  return {
    der: rdnSequence.bytes,
    relativeDistinguishedNames: childrenOf(rdnSequence, 'an RDNSequence').map(rdn => {
      const attributes = childrenOf(
        expectUniversal(rdn, UNIVERSAL.SET, 'a RelativeDistinguishedName'),
        'an RDN',
      );
      // RFC 5280 s4.1.2.4: SET SIZE (1..MAX). An empty RDN is a shape no CA can
      // issue, and one that makes two different names compare equal.
      if (attributes.length === 0) throw structure(rdn, 'an RDN holds at least one attribute');
      return attributes.map(attribute => {
        const fields = fieldsOf(
          expectUniversal(attribute, UNIVERSAL.SEQUENCE, 'AttributeTypeAndValue'),
          'AttributeTypeAndValue',
        );
        const oid = decodeOid(fields.next('type'));
        const value = fields.next('value');
        fields.assertExhausted();
        return { oid, valueDer: value.bytes };
      });
    }),
  };
};

/** IA5String is 7-bit by definition, so anything above is malformed rather than reinterpreted. */
const decodeIa5String = (node: DerNode): string => {
  if (node.content.some(byte => byte > 0x7f)) {
    throw new DerError('malformed-value', node.offset, 'IA5String is 7-bit');
  }
  // Not `String.fromCharCode(...content)`: spreading attacker-sized content into
  // a call is a stack overflow, which is not our failure type.
  return [...node.content].map(byte => String.fromCharCode(byte)).join('');
};

/**
 * GeneralName, tagged by CHOICE position. `directoryName` is [4] EXPLICIT
 * because `Name` is itself a CHOICE; the rest are IMPLICIT.
 *
 * Unrecognised forms keep their tag number rather than being dropped. A name
 * constraint over a form we discarded would be a constraint silently satisfied.
 */
export type GeneralName =
  | { readonly kind: 'rfc822'; readonly value: string }
  | { readonly kind: 'dns'; readonly value: string }
  | { readonly kind: 'uri'; readonly value: string }
  | { readonly kind: 'ip'; readonly bytes: Uint8Array }
  | { readonly kind: 'directory'; readonly name: Name }
  | { readonly kind: 'other'; readonly tagNumber: number; readonly bytes: Uint8Array };

const decodeGeneralName = (node: DerNode): GeneralName => {
  if (node.tagClass !== 'context') throw structure(node, 'a GeneralName is context-tagged');
  switch (node.tagNumber) {
    case 1:
      return { kind: 'rfc822', value: decodeIa5String(node) };
    case 2:
      return { kind: 'dns', value: decodeIa5String(node) };
    case 4:
      // EXPLICIT, so the RDNSequence is this node's single child.
      return { kind: 'directory', name: decodeName(onlyChildOf(node, 'a directoryName')) };
    case 6:
      return { kind: 'uri', value: decodeIa5String(node) };
    case 7:
      return { kind: 'ip', bytes: node.content };
    default:
      return { kind: 'other', tagNumber: node.tagNumber, bytes: node.bytes };
  }
};

const decodeGeneralNames = (node: DerNode, what: string): readonly GeneralName[] =>
  childrenOf(expectUniversal(node, UNIVERSAL.SEQUENCE, what), what).map(decodeGeneralName);

export type BasicConstraints = {
  readonly isCa: boolean;
  /** How many intermediates may follow. Absent means unlimited, which is not zero. */
  readonly maximumPathLength: number | null;
};

const decodeBasicConstraints = (node: DerNode): BasicConstraints => {
  const fields = fieldsOf(
    expectUniversal(node, UNIVERSAL.SEQUENCE, 'BasicConstraints'),
    'BasicConstraints',
  );
  const first = fields.peek();
  // Both fields are OPTIONAL and DEFAULT FALSE. DER omits a default, so a
  // present BOOLEAN false is itself non-conforming — but that is a profile call,
  // and this layer only reads what is there.
  const isCaFieldPresent =
    first !== undefined && first.tagClass === 'universal' && first.tagNumber === 1;
  if (isCaFieldPresent) fields.skip();
  const pathLength = fields.peek();
  if (pathLength !== undefined) fields.skip();
  fields.assertExhausted();
  const maximumPathLength = pathLength === undefined ? null : Number(decodeInteger(pathLength));
  if (
    maximumPathLength !== null &&
    (maximumPathLength < 0 || !Number.isSafeInteger(maximumPathLength))
  ) {
    throw new DerError('malformed-value', node.offset, `pathLenConstraint ${maximumPathLength}`);
  }
  return { isCa: isCaFieldPresent && decodeBoolean(first), maximumPathLength };
};

/** Named exactly as RFC 5280 does, so a required usage from x509-limbo is a direct lookup. */
const KEY_USAGE_BITS = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
] as const;
export type KeyUsageName = (typeof KEY_USAGE_BITS)[number];

const decodeKeyUsage = (node: DerNode): ReadonlySet<KeyUsageName> => {
  const { bytes, unusedBits } = decodeBitString(
    expectUniversal(node, UNIVERSAL.BIT_STRING, 'KeyUsage'),
  );
  const declaredBits = bytes.length * 8 - unusedBits;
  return new Set(
    KEY_USAGE_BITS.filter((_, bit) => {
      if (bit >= declaredBits) return false;
      const octet = bytes[bit >> 3] ?? 0;
      // Bit 0 is the MOST significant bit of the first octet (X.690 s8.6.2).
      return (octet & (0x80 >> (bit % 8))) !== 0;
    }),
  );
};

export type GeneralSubtree = { readonly base: GeneralName };

export type NameConstraints = {
  readonly permitted: readonly GeneralSubtree[];
  readonly excluded: readonly GeneralSubtree[];
};

const decodeGeneralSubtrees = (node: DerNode): readonly GeneralSubtree[] =>
  childrenOf(node, 'GeneralSubtrees').map(subtree => {
    const fields = fieldsOf(
      expectUniversal(subtree, UNIVERSAL.SEQUENCE, 'a GeneralSubtree'),
      'a GeneralSubtree',
    );
    const base = decodeGeneralName(fields.next('base'));
    // RFC 5280 s4.2.1.10 forbids `minimum` and `maximum` in this profile. They
    // are REJECTED rather than ignored: a constraint carrying a range we skipped
    // is a constraint that silently constrains less than it says.
    if (fields.peek() !== undefined) {
      throw structure(
        subtree,
        'a GeneralSubtree carries minimum/maximum, which RFC 5280 s4.2.1.10 forbids',
      );
    }
    return { base };
  });

const decodeNameConstraints = (node: DerNode): NameConstraints => {
  const sequence = expectUniversal(node, UNIVERSAL.SEQUENCE, 'NameConstraints');
  const fields = childrenOf(sequence, 'NameConstraints');

  /**
   * Exhaustive, and at most once each. `.find()` would take the first
   * `excludedSubtrees` and ignore a second — an attacker-controlled restrictive
   * field that never reaches validation, in a critical extension.
   */
  const subtrees = (tagNumber: number): readonly GeneralSubtree[] | null => {
    const matches = fields.filter(
      field => field.tagClass === 'context' && field.tagNumber === tagNumber,
    );
    if (matches.length > 1) throw structure(node, `NameConstraints states [${tagNumber}] twice`);
    const [field] = matches;
    if (field === undefined) return null;
    const decoded = decodeGeneralSubtrees(field);
    // GeneralSubtrees ::= SEQUENCE SIZE (1..MAX). An empty one states nothing.
    if (decoded.length === 0) throw structure(field, `[${tagNumber}] holds no GeneralSubtree`);
    return decoded;
  };

  if (fields.some(field => field.tagClass !== 'context' || field.tagNumber > 1)) {
    throw structure(node, 'NameConstraints holds a field RFC 5280 does not define');
  }
  const permitted = subtrees(0);
  const excluded = subtrees(1);
  if (permitted === null && excluded === null) {
    throw structure(node, 'NameConstraints states neither permitted nor excluded subtrees');
  }
  return { permitted: permitted ?? [], excluded: excluded ?? [] };
};

/** What an extension carried, alongside whether ignoring it is permitted. */
export type Extension<T> = { readonly isCritical: boolean; readonly value: T };

export type AuthorityKeyIdentifier = {
  readonly keyIdentifier: Uint8Array | null;
  readonly hasIssuerAndSerial: boolean;
};

export type Extensions = {
  readonly basicConstraints: Extension<BasicConstraints> | null;
  readonly keyUsage: Extension<ReadonlySet<KeyUsageName>> | null;
  /** OIDs, unmapped. Which OID means `serverAuth` is a policy question, so M4 owns it. */
  readonly extendedKeyUsage: Extension<readonly string[]> | null;
  readonly subjectAltName: Extension<readonly GeneralName[]> | null;
  readonly nameConstraints: Extension<NameConstraints> | null;
  readonly subjectKeyIdentifier: Extension<Uint8Array> | null;
  readonly authorityKeyIdentifier: Extension<AuthorityKeyIdentifier> | null;
  /**
   * How many AccessDescriptions the extension holds. Nothing in RFC 5280 s6.1
   * consults AIA, and we never chase it — this exists only because CABF requires
   * `SEQUENCE SIZE (1..MAX)`, and an empty one is a malformed certificate.
   */
  readonly authorityInfoAccess: Extension<number> | null;
  /** OIDs of every critical extension we do not interpret. M4 fails closed on a non-empty list. */
  readonly unrecognisedCritical: readonly string[];
};

const EXTENSION_OIDS = {
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  authorityKeyIdentifier: '2.5.29.35',
  extendedKeyUsage: '2.5.29.37',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
} as const;

const decodeAuthorityKeyIdentifier = (node: DerNode): AuthorityKeyIdentifier => {
  const fields = childrenOf(
    expectUniversal(node, UNIVERSAL.SEQUENCE, 'AuthorityKeyIdentifier'),
    'AuthorityKeyIdentifier',
  );
  const at = (tagNumber: number): DerNode | undefined =>
    fields.find(child => child.tagClass === 'context' && child.tagNumber === tagNumber);
  return {
    keyIdentifier: at(0)?.content ?? null,
    // authorityCertIssuer [1] and authorityCertSerialNumber [2]. Their CONTENTS
    // are never consulted, but their presence is: CABF 7.1.2.11.1 forbids them,
    // so what matters is that they were there at all.
    hasIssuerAndSerial: at(1) !== undefined || at(2) !== undefined,
  };
};

const decodeExtensions = (node: DerNode): Extensions => {
  const raw = childrenOf(node, 'Extensions').map(extension => {
    const fields = fieldsOf(
      expectUniversal(extension, UNIVERSAL.SEQUENCE, 'an Extension'),
      'an Extension',
    );
    const oid = decodeOid(fields.next('extnID'));
    const second = fields.next('critical or extnValue');
    const isCriticalPresent = second.tagClass === 'universal' && second.tagNumber === 1;
    const extnValue = isCriticalPresent ? fields.next('extnValue') : second;
    fields.assertExhausted();
    return {
      oid,
      isCritical: isCriticalPresent && decodeBoolean(second),
      // Kept as BYTES, undecoded. An extension we do not interpret is not parsed
      // at all — Entrust's private 1.2.840.113533.7.65.0 holds a GeneralString,
      // which RFC 5280 admits nowhere, and eagerly decoding every extension
      // rejects a root that Node and every browser trust. Decoding what you never
      // consume buys nothing and hands an attacker a parser.
      extnValueDer: expectUniversal(extnValue, UNIVERSAL.OCTET_STRING, 'extnValue').content,
    };
  });

  // RFC 5280 s4.2: "A certificate MUST NOT include more than one instance of a
  // particular extension." Two BasicConstraints let an implementation reading the
  // first and one reading the last disagree about the same certificate.
  const seen = new Set<string>();
  for (const { oid } of raw) {
    if (seen.has(oid)) {
      throw new DerError('malformed-structure', node.offset, `extension ${oid} appears twice`);
    }
    seen.add(oid);
  }

  /** Only a recognised extension is decoded, and only then does its content become DER. */
  const find = <T>(oid: string, decode: (node: DerNode) => T): Extension<T> | null => {
    const extension = raw.find(candidate => candidate.oid === oid);
    return extension === undefined
      ? null
      : { isCritical: extension.isCritical, value: decode(decodeDer(extension.extnValueDer)) };
  };

  return {
    basicConstraints: find(EXTENSION_OIDS.basicConstraints, decodeBasicConstraints),
    keyUsage: find(EXTENSION_OIDS.keyUsage, decodeKeyUsage),
    extendedKeyUsage: find(EXTENSION_OIDS.extendedKeyUsage, usage =>
      childrenOf(
        expectUniversal(usage, UNIVERSAL.SEQUENCE, 'ExtKeyUsageSyntax'),
        'ExtKeyUsageSyntax',
      ).map(decodeOid),
    ),
    subjectAltName: find(EXTENSION_OIDS.subjectAltName, san =>
      decodeGeneralNames(san, 'SubjectAltName'),
    ),
    nameConstraints: find(EXTENSION_OIDS.nameConstraints, decodeNameConstraints),
    subjectKeyIdentifier: find(
      EXTENSION_OIDS.subjectKeyIdentifier,
      ski => expectUniversal(ski, UNIVERSAL.OCTET_STRING, 'SubjectKeyIdentifier').content,
    ),
    authorityKeyIdentifier: find(
      EXTENSION_OIDS.authorityKeyIdentifier,
      decodeAuthorityKeyIdentifier,
    ),
    authorityInfoAccess: find(EXTENSION_OIDS.authorityInfoAccess, access => {
      const descriptions = childrenOf(
        expectUniversal(access, UNIVERSAL.SEQUENCE, 'AuthorityInfoAccessSyntax'),
        'AuthorityInfoAccessSyntax',
      );
      // The contents are never read; only that there is at least one.
      if (descriptions.length === 0) {
        throw structure(access, 'AuthorityInfoAccessSyntax holds at least one AccessDescription');
      }
      return descriptions.length;
    }),
    unrecognisedCritical: raw
      .filter(
        ({ oid, isCritical }) => isCritical && !Object.values<string>(EXTENSION_OIDS).includes(oid),
      )
      .map(({ oid }) => oid),
  };
};

export type SubjectPublicKeyInfo = {
  /** The whole SPKI TLV. This is what `tls` hands to `importKey` at M6. */
  readonly der: Uint8Array;
  readonly algorithm: AlgorithmIdentifier;
  readonly subjectPublicKey: Uint8Array;
  readonly unusedBits: number;
};

export type Certificate = {
  readonly der: Uint8Array;
  /**
   * Verbatim, and a VIEW of the input — never rebuilt. A signature is over the
   * bytes the CA signed, and re-encoding to get them back is how a parser that
   * normalises silently verifies a different certificate than it validates.
   */
  readonly tbsCertificateDer: Uint8Array;
  readonly version: 1 | 2 | 3;
  readonly serialNumber: bigint;
  /** Encoded width. RFC 5280 s4.1.2.2 caps a serial at 20 octets, and bigint forgets. */
  readonly serialNumberOctets: number;
  readonly signatureAlgorithm: AlgorithmIdentifier;
  readonly issuer: Name;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly subject: Name;
  readonly subjectPublicKeyInfo: SubjectPublicKeyInfo;
  readonly extensions: Extensions;
  readonly signature: Uint8Array;
};

const VERSIONS = { 0: 1, 1: 2, 2: 3 } as const;

export const decodeCertificate = (der: Uint8Array): Certificate => {
  const certificate = expectUniversal(decodeDer(der), UNIVERSAL.SEQUENCE, 'Certificate');
  const outer = fieldsOf(certificate, 'Certificate');
  const tbs = expectUniversal(outer.next('tbsCertificate'), UNIVERSAL.SEQUENCE, 'TBSCertificate');
  const signatureAlgorithm = decodeAlgorithmIdentifier(outer.next('signatureAlgorithm'));
  const signatureValue = decodeBitString(
    expectUniversal(outer.next('signatureValue'), UNIVERSAL.BIT_STRING, 'signatureValue'),
  );
  outer.assertExhausted();

  const fields = fieldsOf(tbs, 'TBSCertificate');
  const versionField = fields.peek();
  const isVersionPresent =
    versionField !== undefined &&
    versionField.tagClass === 'context' &&
    versionField.tagNumber === 0;
  if (isVersionPresent) fields.skip();
  const version = ((): 1 | 2 | 3 => {
    if (versionField === undefined || !isVersionPresent) return 1;
    const [encoded] = childrenOf(versionField, 'the version field');
    if (encoded === undefined)
      throw structure(versionField, '[0] EXPLICIT Version wraps one INTEGER');
    const value = decodeInteger(encoded);
    const known = VERSIONS[Number(value) as 0 | 1 | 2];
    if (value < 0n || value > 2n || known === undefined) {
      throw new DerError(
        'malformed-value',
        versionField.offset,
        `unknown certificate version ${value}`,
      );
    }
    // DER omits a DEFAULT, so an explicit v1 is a re-encoding of the same
    // certificate with different bytes — and a signature covers bytes.
    if (known === 1) throw structure(versionField, 'version v1 is the DEFAULT and DER omits it');
    return known;
  })();

  const serialNumberField = fields.next('serialNumber');
  // Bounded BEFORE decoding, not after. `decodeInteger` grows a BigInt one octet
  // at a time, so a peer that sends a megabyte-wide INTEGER buys superlinear work
  // from an otherwise well-formed certificate. RFC 5280 s4.1.2.2 caps it at 20.
  if (serialNumberField.content.length > MAXIMUM_SERIAL_OCTETS) {
    throw new DerError(
      'malformed-value',
      serialNumberField.offset,
      `serial is ${serialNumberField.content.length} octets, over the ${MAXIMUM_SERIAL_OCTETS} RFC 5280 allows`,
    );
  }
  const serialNumber = decodeInteger(serialNumberField);
  const innerSignature = decodeAlgorithmIdentifier(fields.next('signature'));
  const issuer = decodeName(fields.next('issuer'));
  const validity = fieldsOf(
    expectUniversal(fields.next('validity'), UNIVERSAL.SEQUENCE, 'Validity'),
    'Validity',
  );
  const notBefore = decodeTime(validity.next('notBefore'));
  const notAfter = decodeTime(validity.next('notAfter'));
  validity.assertExhausted();
  const subject = decodeName(fields.next('subject'));

  const spki = expectUniversal(
    fields.next('subjectPublicKeyInfo'),
    UNIVERSAL.SEQUENCE,
    'SubjectPublicKeyInfo',
  );
  const spkiFields = fieldsOf(spki, 'SubjectPublicKeyInfo');
  const keyAlgorithm = decodeAlgorithmIdentifier(spkiFields.next('algorithm'));
  const subjectPublicKey = decodeBitString(
    expectUniversal(spkiFields.next('subjectPublicKey'), UNIVERSAL.BIT_STRING, 'subjectPublicKey'),
  );
  spkiFields.assertExhausted();

  // issuerUniqueID [1] and subjectUniqueID [2] are v2-and-later, and read but
  // unused: nothing in RFC 5280 s6.1 consults them. Skipping them WITHOUT
  // consuming them would push `extensions` off by one.
  for (const tagNumber of [1, 2]) {
    const unique = fields.peek();
    if (unique?.tagClass === 'context' && unique.tagNumber === tagNumber) {
      if (version === 1)
        throw structure(unique, `[${tagNumber}] UniqueIdentifier needs v2 or later`);
      fields.skip();
    }
  }

  const extensionsField = fields.peek();
  const hasExtensions =
    extensionsField !== undefined &&
    extensionsField.tagClass === 'context' &&
    extensionsField.tagNumber === 3;
  if (hasExtensions) fields.skip();
  fields.assertExhausted();

  const extensions = ((): Extensions => {
    if (!hasExtensions || extensionsField === undefined) {
      return {
        basicConstraints: null,
        keyUsage: null,
        extendedKeyUsage: null,
        subjectAltName: null,
        nameConstraints: null,
        subjectKeyIdentifier: null,
        authorityKeyIdentifier: null,
        authorityInfoAccess: null,
        unrecognisedCritical: [],
      };
    }
    if (version !== 3) throw structure(extensionsField, 'extensions need v3');
    const [sequence] = childrenOf(extensionsField, 'the extensions field');
    if (sequence === undefined)
      throw structure(extensionsField, '[3] EXPLICIT Extensions wraps one SEQUENCE');
    const extensionList = expectUniversal(sequence, UNIVERSAL.SEQUENCE, 'Extensions');
    // RFC 5280 s4.1.2.9: Extensions ::= SEQUENCE SIZE (1..MAX).
    if (childrenOf(extensionList, 'Extensions').length === 0) {
      throw structure(extensionList, 'an empty extensions SEQUENCE is not encodable');
    }
    return decodeExtensions(extensionList);
  })();

  // RFC 5280 s4.1.1.2: the two MUST match. They are signed and unsigned copies of
  // the same statement, so a mismatch means the outer one — the one a naive
  // implementation reads to pick a verification algorithm — is unauthenticated.
  if (!isSameAlgorithm(signatureAlgorithm, innerSignature)) {
    throw structure(
      certificate,
      `signatureAlgorithm ${signatureAlgorithm.oid} does not match tbsCertificate.signature ${innerSignature.oid}`,
    );
  }

  return {
    der,
    tbsCertificateDer: tbs.bytes,
    version,
    serialNumber,
    serialNumberOctets: serialNumberField.content.length,
    signatureAlgorithm,
    issuer,
    notBefore,
    notAfter,
    subject,
    subjectPublicKeyInfo: {
      der: spki.bytes,
      algorithm: keyAlgorithm,
      subjectPublicKey: subjectPublicKey.bytes,
      unusedBits: subjectPublicKey.unusedBits,
    },
    extensions,
    signature: signatureValue.bytes,
  };
};
