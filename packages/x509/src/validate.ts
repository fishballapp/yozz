/**
 * Chain building and RFC 5280 s6.1 path validation — the package's reason to
 * exist, and the only file here that decides trust.
 *
 * Two shapes are load-bearing. Path building is a SEARCH, not a walk: a subject
 * name can be issued by several keys (that is what a cross-sign is), so finding
 * one chain that fails says nothing about whether another succeeds. And every
 * bound is explicit, because `pathological::` hands us cycles and
 * `denial-of-service` is deliberately not skipped from the profile.
 */
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
 * Total work the search may do, counted in steps rather than in completed paths.
 *
 * Cycles are already broken by not reusing a certificate within one path, and
 * that is NOT enough: `pathological::pathological-chain-*` supplies 100 distinct
 * intermediates that all chain, so an acyclic search still explores
 * combinatorially many orderings. Bounding finished paths bounds nothing,
 * because the blow-up happens before any path finishes.
 *
 * ponytail: a flat budget, not a smarter search. Real WebPKI chains are three or
 * four links from a handful of candidates, so this is never approached in
 * practice; if a legitimate cross-signed graph ever exhausts it, order candidates
 * by authority key identifier before raising the number.
 */
const MAXIMUM_SEARCH_STEPS = 512;

/** Beyond this, no real WebPKI chain exists and we are being fed a graph to explore. */
const MAXIMUM_INTERMEDIATES = 8;

const EXTENDED_KEY_USAGE_OIDS: Readonly<Record<string, string>> = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const ANY_EXTENDED_KEY_USAGE = '2.5.29.37.0';
/** RFC 5280 s4.1.2.2. Twenty octets, and a CA that needs more has a different problem. */
const MAXIMUM_SERIAL_OCTETS = 20;

/** Where a certificate sits in the path, which is what its conformance rules key off. */
type PathRole = 'anchor' | 'issuer' | 'leaf';

/**
 * The RFC 5280 and CABF MUSTs a certificate owes for its position in the path.
 *
 * These read like paperwork and are not. Each one closes a way for a
 * certificate to be ambiguous about who signed it, or about what name it
 * speaks for — and an ambiguity an attacker chooses is not paperwork.
 */
const conformanceViolation = (
  certificate: Certificate,
  role: PathRole,
): { code: 'malformed-certificate' } | null => {
  const malformed = { code: 'malformed-certificate' } as const;
  const authority = certificate.extensions.authorityKeyIdentifier;
  const subjectKeyId = certificate.extensions.subjectKeyIdentifier;
  const subjectAltName = certificate.extensions.subjectAltName;
  const hasSubjectName = certificate.subject.relativeDistinguishedNames.length > 0;

  // RFC 5280 s4.2.1.1 and s4.2.1.2 both say non-critical, and CABF 7.1.2.11.1
  // forbids an authority key identifier that names an issuer and serial rather
  // than a key — a chain hint pointing at something other than a key.
  if (authority?.isCritical === true || subjectKeyId?.isCritical === true) return malformed;
  // RFC 5280 s4.2.2.1 marks AIA non-critical. Recognising the extension means it
  // no longer trips the unknown-critical rule, so state it directly.
  if (certificate.extensions.authorityInfoAccess?.isCritical === true) return malformed;
  if (authority?.value.hasIssuerAndSerial === true) return malformed;

  /**
   * RFC 5280 s4.2.1.6: an empty subject means the SAN carries the whole
   * identity, so the SAN MUST be critical — otherwise an implementation that
   * skips non-critical extensions is left with a certificate that names nobody.
   * CABF 7.1.2.7.12 states the other half: with a subject present, a critical
   * SAN is forbidden.
   */
  if (!hasSubjectName && (subjectAltName === null || !subjectAltName.isCritical)) return malformed;
  if (hasSubjectName && subjectAltName?.isCritical === true) return malformed;

  if (role !== 'leaf') {
    // RFC 5280 s4.1.2.6. A CA has to be nameable: name constraints are matched
    // against the subject, so a CA with no subject has nothing to constrain.
    if (!hasSubjectName) return malformed;
    if (subjectKeyId === null) return malformed;
  }

  /**
   * Two separate rules, and folding them together cost two valid chains.
   *
   * A stated authority key identifier must NAME A KEY — always, anchors
   * included, because one that states an issuer instead is pointing the path
   * builder somewhere it cannot verify.
   *
   * Whether one must be stated at all is a different question, and only
   * non-anchors owe it. Demanding it of an anchor rejects `cve::cve-2024-0567`
   * and `rfc5280::root-and-intermediate-swapped`, both valid: a trust anchor is
   * trusted because it is IN the store, not because it names its issuer.
   */
  if (authority !== null && authority.value.keyIdentifier === null) return malformed;
  if (role !== 'anchor' && authority === null) return malformed;

  // nameConstraints is meaningless on something that issues nothing (s4.2.1.10).
  if (role === 'leaf' && certificate.extensions.nameConstraints !== null) return malformed;
  return null;
};

const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** A certificate whose issuer is its own subject: exempt from several s6.1 steps. */
const isSelfIssued = (certificate: Certificate): boolean =>
  isSameBytes(certificate.issuer.der, certificate.subject.der);

type Link = {
  readonly certificate: Certificate;
  readonly ref: CertificateRef;
  /** Only ever set on an anchor. Carried here so the check has both halves. */
  readonly serverDistrustAfter?: Date | null;
};

/** Subject DN and every SAN, which is the set name constraints apply to. */
const constrainedNamesOf = (certificate: Certificate): readonly GeneralName[] => [
  // An empty DN constrains nothing and must not be compared as if it did.
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

  // RFC 5280 s6.1 treats an anchor as a name and a key, and x509-limbo does not:
  // an expired root, a root without basic constraints, a root whose cA bit and
  // keyCertSign disagree, and a root carrying an unknown critical extension are
  // each expected to FAIL. A trust anchor is trusted to be a CA, not to be valid.
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
  /**
   * A SELF-SIGNED root signs itself, so its authority key identifier — when it
   * states one — must name its own key. One naming a different key is telling
   * the path builder something untrue about who issued it.
   *
   * Only when self-signed. An intermediate can be placed in a trust store and
   * used as an anchor, and its authority key identifier then correctly points at
   * the root above it — `rfc5280::root-and-intermediate-swapped` is that exact
   * shape, and checking every anchor rejects a chain the suite calls valid.
   */
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
  // CABF 7.1.2.1: a root states no EKU. One that does is constraining itself in
  // a way no relying party is required to honour, which is worse than silence.
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
  // The anchor's own pathLenConstraint binds the path too. Under a
  // whole-certificate anchor model, a root that says `pathlen:0` means it, and
  // reading its cA bit while ignoring its depth limit honours half a statement.
  let remainingIntermediates = Math.min(
    request.maximumIntermediateCount ?? MAXIMUM_INTERMEDIATES,
    MAXIMUM_INTERMEDIATES,
    anchorBasicConstraints.value.maximumPathLength ?? MAXIMUM_INTERMEDIATES,
  );

  for (const [index, { certificate, ref }] of chain.entries()) {
    const isLeaf = index === chain.length - 1;

    /**
     * Name CHAINING compares bytes, deliberately, while name CONSTRAINTS compare
     * canonically (`names.ts`). The asymmetry is the point, not an oversight.
     *
     * We declared the WebPKI profile, and CABF requires a certificate's issuer
     * field to be byte-identical to its CA's subject. Comparing canonically here
     * would build chains the profile does not allow, which is the permissive
     * direction. And a miss costs a REJECTION, where a missed name constraint
     * costs an authorisation — so the two want opposite defaults.
     */
    if (!isSameBytes(certificate.issuer.der, workingIssuerName)) {
      return { code: 'no-path-to-trust-anchor' };
    }
    if (certificate.serialNumber <= 0n) {
      return { code: 'malformed-certificate', certificate: ref };
    }
    if (certificate.serialNumberOctets > MAXIMUM_SERIAL_OCTETS) {
      return { code: 'malformed-certificate', certificate: ref };
    }
    // RFC 5280 encodes validity to the SECOND, so a comparison at millisecond
    // resolution invents a precision the certificate never stated.
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

    // s6.1.3(b)(c): a self-issued certificate that is not the leaf is exempt,
    // because it re-states a name the issuer was already authorised for.
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
    /**
     * A CA that states an EKU has CONSTRAINED itself, and the constraint has to
     * survive to the leaf. Without this, possession of a trusted CA key that was
     * deliberately restricted away from `serverAuth` still lets its holder
     * impersonate a mail server — the six `bettertls::pathbuilding` BAD_EKU
     * cases are exactly that. `anyExtendedKeyUsage` IS accepted here, unlike on
     * a leaf: on a CA it is a statement of breadth, not a refusal to be specific.
     */
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

  /**
   * Mozilla's server distrust-after, compared against the LEAF rather than the
   * clock.
   *
   * A root program retires a CA by refusing what it issues from a date onward,
   * because the certificates it already signed were issued in good faith and
   * their owners did nothing wrong. Dropping the root outright would refuse
   * those too — chains every browser still accepts — for up to the life of a
   * leaf, which for public mail is 60-90 days. So a root past its cutoff still
   * anchors everything it signed before it, and only newer leaves are refused.
   *
   * The LEAF, not every certificate in the chain: an intermediate is reissued
   * on the CA's own schedule, and the rule is about what reaches subscribers.
   *
   * Checked here, after the chain has verified, rather than up with the other
   * anchor checks. A chain that does not verify has a better diagnosis than
   * this one, and reporting a distrusted CA for it would send the reader after
   * the wrong thing.
   */
  if (
    anchor.serverDistrustAfter != null &&
    leaf.certificate.notBefore.getTime() > anchor.serverDistrustAfter.getTime()
  ) {
    return { code: 'certificate-authority-distrusted', certificate: anchor.ref };
  }

  // WebPKI: a CA certificate is not a server certificate, however it was issued.
  if (leaf.certificate.extensions.basicConstraints?.value.isCa === true) {
    return { code: 'basic-constraints-violation', certificate: leaf.ref };
  }
  // Widened to strings deliberately: x509-limbo supplies required usages as the
  // RFC 5280 names, which is exactly how KeyUsage decodes them.
  const presentKeyUsages: ReadonlySet<string> =
    leaf.certificate.extensions.keyUsage?.value ?? new Set();
  const isKeyUsageDeclared = leaf.certificate.extensions.keyUsage !== null;
  if (
    isKeyUsageDeclared &&
    !request.requiredKeyUsages.every(usage => presentKeyUsages.has(usage))
  ) {
    return { code: 'key-usage-violation', certificate: leaf.ref };
  }
  // A leaf that can sign certificates is a CA however its basicConstraints read.
  if (presentKeyUsages.has('keyCertSign')) {
    return { code: 'key-usage-violation', certificate: leaf.ref };
  }

  /**
   * CABF 7.1.2.7.9: a server certificate MUST carry an EKU naming serverAuth.
   * `anyExtendedKeyUsage` does NOT stand in for it — x509-limbo's `ee-anyeku`
   * and `ee-without-eku` both expect refusal, and this package exists to
   * validate servers.
   */
  const extendedKeyUsage = leaf.certificate.extensions.extendedKeyUsage;
  const present = new Set(extendedKeyUsage?.value ?? []);
  // CABF 7.1.2.7.10: an EE states the usages it has, so `anyExtendedKeyUsage`
  // is a refusal to state them, and a critical EKU is forbidden outright.
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

    // A malformed intermediate is UNUSABLE, not fatal: the set is untrusted
    // input and a chain may well exist that never touches it.
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
        // Cycle break. A chain is at most nine links, so scanning it beats
        // hashing a multi-kilobyte certificate into a Set key.
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
