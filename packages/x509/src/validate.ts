import { type Certificate, decodeCertificate, type GeneralName } from './certificate.ts';
import { DerError } from './der.ts';
import {
  addConstraints,
  type ConstraintState,
  EMPTY_CONSTRAINTS,
  matchesPeerName,
  violatesConstraints,
} from './names.ts';
import type {
  CertificateRef,
  PathValidationRequest,
  PathValidationResult,
  ValidationFailure,
  Validator,
} from './validator.ts';
import { rejectKey, verifySignature } from './verify.ts';

/**
 * Counted in steps, not finished paths: 100 distinct intermediates that all chain make an acyclic
 * search explore combinatorially many orderings before any path finishes.
 */
const MAXIMUM_SEARCH_STEPS = 512;

/** No real WebPKI chain is deeper. */
const MAXIMUM_INTERMEDIATES = 8;

const EXTENDED_KEY_USAGE_OIDS: Readonly<Record<string, string>> = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const ANY_EXTENDED_KEY_USAGE = '2.5.29.37.0';
/** RFC 5280 §4.1.2.2. */
const MAXIMUM_SERIAL_OCTETS = 20;

type PathRole = 'anchor' | 'issuer' | 'leaf';

/** The RFC 5280 and CABF MUSTs a certificate owes for its position in the path. */
const conformanceViolation = (
  certificate: Certificate,
  role: PathRole,
): { code: 'malformed-certificate' } | null => {
  const malformed = { code: 'malformed-certificate' } as const;
  const authority = certificate.extensions.authorityKeyIdentifier;
  const subjectKeyId = certificate.extensions.subjectKeyIdentifier;
  const subjectAltName = certificate.extensions.subjectAltName;
  const hasSubjectName = certificate.subject.relativeDistinguishedNames.length > 0;

  // RFC 5280 §4.2.1.1 and §4.2.1.2: non-critical. CABF 7.1.2.11.1: no issuer-and-serial form.
  if (authority?.isCritical === true || subjectKeyId?.isCritical === true) return malformed;
  // RFC 5280 §4.2.2.1: AIA is non-critical.
  if (certificate.extensions.authorityInfoAccess?.isCritical === true) return malformed;
  if (authority?.value.hasIssuerAndSerial === true) return malformed;

  // RFC 5280 §4.2.1.6: an empty subject needs a critical SAN. CABF 7.1.2.7.12: a subject forbids one.
  if (!hasSubjectName && (subjectAltName === null || !subjectAltName.isCritical)) return malformed;
  if (hasSubjectName && subjectAltName?.isCritical === true) return malformed;

  if (role !== 'leaf') {
    // RFC 5280 §4.1.2.6: a CA has a subject, since name constraints match against it.
    if (!hasSubjectName) return malformed;
    if (subjectKeyId === null) return malformed;
  }

  // A stated authority key identifier must name a key; only a non-anchor must state one at all
  // (`rfc5280::root-and-intermediate-swapped` is a valid anchor without one).
  if (authority !== null && authority.value.keyIdentifier === null) return malformed;
  if (role !== 'anchor' && authority === null) return malformed;

  // RFC 5280 §4.2.1.10: nameConstraints is meaningless on a leaf.
  if (role === 'leaf' && certificate.extensions.nameConstraints !== null) return malformed;
  return null;
};

const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Exempt from several §6.1 steps. */
const isSelfIssued = (certificate: Certificate): boolean =>
  isSameBytes(certificate.issuer.der, certificate.subject.der);

type Link = {
  readonly certificate: Certificate;
  readonly ref: CertificateRef;
  /** Only ever set on an anchor. */
  readonly serverDistrustAfter?: Date | null;
};

/** What name constraints apply to. */
const constrainedNamesOf = (certificate: Certificate): readonly GeneralName[] => [
  ...(certificate.subject.relativeDistinguishedNames.length === 0
    ? []
    : [{ kind: 'directory' as const, name: certificate.subject }]),
  ...(certificate.extensions.subjectAltName?.value ?? []),
];

const validatePathCandidate = async (
  anchor: Link,
  chain: readonly Link[],
  request: PathValidationRequest,
): Promise<ValidationFailure | null> => {
  const time = Math.floor(request.validationTime.getTime() / 1000) * 1000;

  // RFC 5280 §6.1 treats an anchor as a name and a key; x509-limbo expects an expired or
  // non-CA root to fail, and this validator follows limbo.
  const anchorBasicConstraints = anchor.certificate.extensions.basicConstraints;
  if (
    anchorBasicConstraints === null ||
    !anchorBasicConstraints.isCritical ||
    !anchorBasicConstraints.value.isCa
  ) {
    return { code: 'basic-constraints-violation', certificate: anchor.ref };
  }
  const anchorKeyUsage = anchor.certificate.extensions.keyUsage;
  if (anchorKeyUsage !== null && !anchorKeyUsage.value.has('keyCertSign')) {
    return { code: 'key-usage-violation', certificate: anchor.ref };
  }
  const anchorConformance = conformanceViolation(anchor.certificate, 'anchor');
  if (anchorConformance !== null) return { ...anchorConformance, certificate: anchor.ref };
  // A self-signed anchor's authority key identifier must name its own key. Only when self-signed:
  // an intermediate used as an anchor correctly names the root above it.
  const anchorAuthorityKeyId =
    anchor.certificate.extensions.authorityKeyIdentifier?.value.keyIdentifier;
  const anchorSubjectKeyId = anchor.certificate.extensions.subjectKeyIdentifier?.value;
  if (
    isSelfIssued(anchor.certificate) &&
    anchorAuthorityKeyId !== undefined &&
    anchorAuthorityKeyId !== null &&
    anchorSubjectKeyId !== undefined &&
    !isSameBytes(anchorAuthorityKeyId, anchorSubjectKeyId)
  ) {
    return { code: 'malformed-certificate', certificate: anchor.ref };
  }
  // CABF 7.1.2.1: a root states no EKU.
  if (anchor.certificate.extensions.extendedKeyUsage !== null) {
    return { code: 'extended-key-usage-violation', certificate: anchor.ref };
  }
  if (anchor.certificate.extensions.unrecognisedCritical.length > 0) {
    return { code: 'unknown-critical-extension', certificate: anchor.ref };
  }
  if (anchor.certificate.notBefore.getTime() > time) {
    return { code: 'certificate-not-yet-valid', certificate: anchor.ref };
  }
  if (anchor.certificate.notAfter.getTime() < time) {
    return { code: 'certificate-expired', certificate: anchor.ref };
  }

  let workingIssuerName = anchor.certificate.subject.der;
  let workingKey = anchor.certificate.subjectPublicKeyInfo;
  let constraints: ConstraintState = addConstraints(
    EMPTY_CONSTRAINTS,
    anchor.certificate.extensions.nameConstraints?.value ?? null,
  );
  // The anchor's own pathLenConstraint binds the path too.
  let remainingIntermediates = Math.min(
    request.maximumIntermediateCount ?? MAXIMUM_INTERMEDIATES,
    MAXIMUM_INTERMEDIATES,
    anchorBasicConstraints.value.maximumPathLength ?? MAXIMUM_INTERMEDIATES,
  );

  for (const [index, { certificate, ref }] of chain.entries()) {
    const isLeaf = index === chain.length - 1;

    // Chaining compares bytes (CABF requires the issuer field byte-identical to the CA's subject);
    // name constraints compare canonically. A miss here costs a rejection, there an authorisation.
    if (!isSameBytes(certificate.issuer.der, workingIssuerName)) {
      return { code: 'no-path-to-trust-anchor' };
    }
    if (certificate.serialNumber <= 0n) {
      return { code: 'malformed-certificate', certificate: ref };
    }
    if (certificate.serialNumberOctets > MAXIMUM_SERIAL_OCTETS) {
      return { code: 'malformed-certificate', certificate: ref };
    }
    // Validity is encoded to the second, so `time` is truncated to one.
    if (certificate.notBefore.getTime() > time) {
      return { code: 'certificate-not-yet-valid', certificate: ref };
    }
    if (certificate.notAfter.getTime() < time) {
      return { code: 'certificate-expired', certificate: ref };
    }
    if (certificate.extensions.unrecognisedCritical.length > 0) {
      return { code: 'unknown-critical-extension', certificate: ref };
    }
    const conformance = conformanceViolation(certificate, isLeaf ? 'leaf' : 'issuer');
    if (conformance !== null) return { ...conformance, certificate: ref };
    if (rejectKey(certificate.subjectPublicKeyInfo) !== null) {
      return { code: 'unsupported-signature-algorithm', certificate: ref };
    }

    const verdict = await verifySignature({
      signedDer: certificate.tbsCertificateDer,
      signature: certificate.signature,
      algorithm: certificate.signatureAlgorithm,
      issuerKey: workingKey,
    });
    if (verdict === 'unsupported-algorithm' || verdict === 'unusable-key') {
      return { code: 'unsupported-signature-algorithm', certificate: ref };
    }
    if (verdict !== 'valid') return { code: 'invalid-signature', certificate: ref };

    // §6.1.3(b)(c): a self-issued non-leaf is exempt.
    if (isLeaf || !isSelfIssued(certificate)) {
      if (violatesConstraints(constrainedNamesOf(certificate), constraints)) {
        return { code: 'name-constraints-violation', certificate: ref };
      }
    }

    if (isLeaf) break;

    const basicConstraints = certificate.extensions.basicConstraints;
    if (basicConstraints === null || !basicConstraints.value.isCa) {
      return { code: 'basic-constraints-violation', certificate: ref };
    }
    const keyUsage = certificate.extensions.keyUsage;
    if (keyUsage !== null && !keyUsage.value.has('keyCertSign')) {
      return { code: 'key-usage-violation', certificate: ref };
    }
    // A CA that states an EKU has constrained what it may issue (`bettertls::pathbuilding` BAD_EKU).
    // `anyExtendedKeyUsage` is accepted on a CA, unlike on a leaf.
    const issuerExtendedKeyUsage = certificate.extensions.extendedKeyUsage;
    if (
      issuerExtendedKeyUsage !== null &&
      !issuerExtendedKeyUsage.value.includes(SERVER_AUTH_OID) &&
      !issuerExtendedKeyUsage.value.includes(ANY_EXTENDED_KEY_USAGE)
    ) {
      return { code: 'extended-key-usage-violation', certificate: ref };
    }
    if (!isSelfIssued(certificate)) {
      if (remainingIntermediates <= 0) return { code: 'maximum-chain-depth-exceeded' };
      remainingIntermediates -= 1;
    }
    const pathLength = basicConstraints.value.maximumPathLength;
    if (pathLength !== null) remainingIntermediates = Math.min(remainingIntermediates, pathLength);

    constraints = addConstraints(
      constraints,
      certificate.extensions.nameConstraints?.value ?? null,
    );
    workingIssuerName = certificate.subject.der;
    workingKey = certificate.subjectPublicKeyInfo;
  }

  const leaf = chain.at(-1);
  if (leaf === undefined) return { code: 'no-path-to-trust-anchor' };

  // Mozilla's distrust-after is compared against the leaf's notBefore, not the clock: a root past
  // its cutoff still anchors what it signed before it. After verification, so a broken chain gets
  // its own diagnosis.
  if (
    anchor.serverDistrustAfter != null &&
    leaf.certificate.notBefore.getTime() > anchor.serverDistrustAfter.getTime()
  ) {
    return { code: 'certificate-authority-distrusted', certificate: anchor.ref };
  }

  // A CA certificate is not a server certificate.
  if (leaf.certificate.extensions.basicConstraints?.value.isCa === true) {
    return { code: 'basic-constraints-violation', certificate: leaf.ref };
  }
  const presentKeyUsages: ReadonlySet<string> =
    leaf.certificate.extensions.keyUsage?.value ?? new Set();
  const isKeyUsageDeclared = leaf.certificate.extensions.keyUsage !== null;
  if (
    isKeyUsageDeclared &&
    !request.requiredKeyUsages.every(usage => presentKeyUsages.has(usage))
  ) {
    return { code: 'key-usage-violation', certificate: leaf.ref };
  }
  // A leaf that can sign certificates is a CA.
  if (presentKeyUsages.has('keyCertSign')) {
    return { code: 'key-usage-violation', certificate: leaf.ref };
  }

  // CABF 7.1.2.7.9: a server certificate carries an EKU naming serverAuth.
  const extendedKeyUsage = leaf.certificate.extensions.extendedKeyUsage;
  const present = new Set(extendedKeyUsage?.value ?? []);
  // CABF 7.1.2.7.10: no `anyExtendedKeyUsage` and no critical EKU on an end entity.
  if (present.has(ANY_EXTENDED_KEY_USAGE) || extendedKeyUsage?.isCritical === true) {
    return { code: 'extended-key-usage-violation', certificate: leaf.ref };
  }
  const isServerAuthDeclared = present.has(SERVER_AUTH_OID);
  const areRequestedUsagesPresent = request.requiredExtendedKeyUsages.every(usage => {
    const oid = EXTENDED_KEY_USAGE_OIDS[usage];
    return oid !== undefined && present.has(oid);
  });
  if (!isServerAuthDeclared || !areRequestedUsagesPresent) {
    return { code: 'extended-key-usage-violation', certificate: leaf.ref };
  }

  if (
    request.expectedPeerName !== null &&
    !matchesPeerName(
      leaf.certificate.extensions.subjectAltName?.value ?? [],
      request.expectedPeerName,
    )
  ) {
    return { code: 'name-mismatch' };
  }
  return null;
};

export const YOZZ_VALIDATOR: Validator = {
  name: '@yozz.app/x509',
  validatePath: async (request: PathValidationRequest): Promise<PathValidationResult> => {
    const peer = ((): Certificate | ValidationFailure => {
      try {
        return decodeCertificate(request.peerCertificateDer);
      } catch (error) {
        if (error instanceof DerError) {
          return { code: 'malformed-certificate', certificate: { source: 'peer' } };
        }
        throw error;
      }
    })();
    if (!('subject' in peer)) return { ok: false, reason: peer };

    // A malformed intermediate is unusable, not fatal.
    const intermediates = request.untrustedIntermediateDer.flatMap((der, inputIndex): Link[] => {
      try {
        return [
          { certificate: decodeCertificate(der), ref: { source: 'intermediate', inputIndex } },
        ];
      } catch (error) {
        if (error instanceof DerError) return [];
        throw error;
      }
    });

    let firstFailure: ValidationFailure | null = null;
    let budget = MAXIMUM_SEARCH_STEPS;

    const search = async (chain: readonly Link[]): Promise<PathValidationResult | null> => {
      const head = chain[0];
      budget -= 1;
      if (head === undefined || budget <= 0) return null;
      const issuerName = head.certificate.issuer.der;

      const anchors = request.trustAnchors
        .findCandidates({
          issuerNameDer: issuerName,
          authorityKeyIdentifier:
            head.certificate.extensions.authorityKeyIdentifier?.value.keyIdentifier ?? null,
        })
        .flatMap((anchor): Link[] => {
          try {
            const certificate = decodeCertificate(anchor.certificateDer);
            return isSameBytes(certificate.subject.der, issuerName)
              ? [
                  {
                    certificate,
                    ref: { source: 'trust-anchor', id: anchor.id },
                    serverDistrustAfter: anchor.serverDistrustAfter,
                  },
                ]
              : [];
          } catch (error) {
            if (error instanceof DerError) return [];
            throw error;
          }
        });

      for (const anchor of anchors) {
        budget -= 1;
        const failure = await validatePathCandidate(anchor, chain, request);
        if (failure === null) {
          return {
            ok: true,
            path: {
              leafSubjectPublicKeyInfoDer: peer.subjectPublicKeyInfo.der,
              intermediates: chain.slice(0, -1).map(link => link.certificate.der),
              trustAnchorId: anchor.ref.source === 'trust-anchor' ? anchor.ref.id : '',
            },
          };
        }
        firstFailure ??= failure;
      }

      if (chain.length > MAXIMUM_INTERMEDIATES) return null;
      for (const candidate of intermediates) {
        if (!isSameBytes(candidate.certificate.subject.der, issuerName)) continue;
        // Cycle break.
        if (chain.some(link => isSameBytes(link.certificate.der, candidate.certificate.der))) {
          continue;
        }
        const found = await search([candidate, ...chain]);
        if (found !== null) return found;
      }
      return null;
    };

    const leaf: Link = { certificate: peer, ref: { source: 'peer' } };
    const found = await search([leaf]);
    return found ?? { ok: false, reason: firstFailure ?? { code: 'no-path-to-trust-anchor' } };
  },
};
