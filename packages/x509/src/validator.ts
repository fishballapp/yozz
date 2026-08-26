/**
 * The path-validation contract.
 *
 * FROZEN at the end of M1 (2026-08-18), after the OpenSSL control was calibrated
 * against x509-limbo's published results for the same version: 185 identically
 * flagged cases, and every residual disagreement attributed. See harness/README.md.
 *
 * RE-FROZEN the same day: `TrustAnchor` held a subject-plus-SPKI summary, which
 * cannot express a root's own constraints, and the harness was not putting
 * anchors in the request at all. Both are fixed below.
 *
 * That the fix moved no verdicts rests on the PEM/DER round trip the adapter now
 * performs being lossless — measured across every trusted certificate in the
 * pinned corpus, 9780 of them, zero byte differences. The unchanged set of 191
 * disagreements corroborates it but cannot prove it alone: the runner compares
 * only `ok`, so on the 8838 cases that expect FAILURE a corrupted anchor still
 * rejects and still looks like agreement.
 *
 * Three fields the control could not drive — `maximumIntermediateCount`,
 * `requiredKeyUsages`, `requiredExtendedKeyUsages` — were shape-untested at the
 * freeze. M4 reads all three, and the suite exercises them, so they are not any
 * more: the shapes survived first contact unchanged.
 *
 * Two shapes here are deliberate and expensive to change later:
 *
 *  - Every input is an argument, trust anchors and time included. A validator
 *    that reaches for a compiled-in store or reads the clock cannot be driven by
 *    x509-limbo at all, since each case supplies its own.
 *  - Failure is a typed value, never a thrown promise. A rejected promise is
 *    reserved for our own bugs, so `tls` never grows two failure paths that
 *    disagree about which alert to send.
 */

/** A name the peer certificate must match. 4455 of limbo's cases are IP, not DNS. */
export type PeerName =
  | { readonly kind: 'dns'; readonly value: string }
  | { readonly kind: 'ip'; readonly value: string };

/**
 * Trust anchors are looked up by issuer name AND authority key identifier — the
 * AKI can be absent, so an SKI-only index is incomplete. One subject can carry
 * several keys, which is what a cross-sign is, so this returns candidates.
 *
 * A source MAY return more than the query implies, up to its whole store.
 * Over-approximating is always sound because the validator verifies every
 * candidate it is handed, and it is what lets an unindexed source — the
 * harness's, holding the three roots one testcase supplied — exist at all.
 */
export type TrustAnchorSource = {
  readonly findCandidates: (query: {
    readonly issuerNameDer: Uint8Array;
    readonly authorityKeyIdentifier: Uint8Array | null;
  }) => readonly TrustAnchor[];
};

export type TrustAnchor = {
  readonly id: string;
  /**
   * The WHOLE certificate, not a subject-plus-SPKI summary of it. A root's own
   * name constraints, key usage, basic constraints and validity are all path
   * validation inputs (RFC 5280 s6.1) and x509-limbo has cases turning on each,
   * none of which a summary can express. A trust store that cannot say what it
   * trusts is the shape this type had before.
   */
  readonly certificateDer: Uint8Array;
  /**
   * Mozilla's server distrust-after cutoff for this root, or `null` for the
   * roots — nearly all of them — that carry none.
   *
   * A root program retires a CA by refusing what it issues from a date onward,
   * NOT by removing it: certificates already in the wild were issued in good
   * faith and keep working until they expire. So the cutoff is compared against
   * the LEAF's `notBefore`, and a root past its cutoff still anchors the chains
   * it signed before it.
   *
   * Required rather than optional on purpose. A trust source that has no
   * cutoffs says `null` and means it; one that forgot the field would silently
   * mean the same thing, and this is not a field to be silent about.
   */
  readonly serverDistrustAfter: Date | null;
};

export type PathValidationRequest = {
  readonly peerCertificateDer: Uint8Array;
  readonly untrustedIntermediateDer: readonly Uint8Array[];
  readonly trustAnchors: TrustAnchorSource;
  /** Never the clock. 9610 of limbo's cases pin this. */
  readonly validationTime: Date;
  readonly expectedPeerName: PeerName | null;
  readonly requiredKeyUsages: readonly string[];
  readonly requiredExtendedKeyUsages: readonly string[];
  /**
   * Limbo counts INTERMEDIATES, not certificates: a depth of 0 permits
   * root -> leaf directly. Named for what it counts so the off-by-one has
   * nowhere to hide.
   */
  readonly maximumIntermediateCount: number | null;
};

/** Which input a failure refers to. A failed multi-path search has no authoritative final chain. */
export type CertificateRef =
  | { readonly source: 'peer' }
  | { readonly source: 'intermediate'; readonly inputIndex: number }
  | { readonly source: 'trust-anchor'; readonly id: string };

export type ValidationFailure =
  | { readonly code: 'malformed-certificate'; readonly certificate: CertificateRef }
  | { readonly code: 'certificate-expired'; readonly certificate: CertificateRef }
  | { readonly code: 'certificate-not-yet-valid'; readonly certificate: CertificateRef }
  | { readonly code: 'unsupported-signature-algorithm'; readonly certificate: CertificateRef }
  | { readonly code: 'unknown-critical-extension'; readonly certificate: CertificateRef }
  | { readonly code: 'basic-constraints-violation'; readonly certificate: CertificateRef }
  | { readonly code: 'key-usage-violation'; readonly certificate: CertificateRef }
  | { readonly code: 'extended-key-usage-violation'; readonly certificate: CertificateRef }
  | { readonly code: 'name-constraints-violation'; readonly certificate: CertificateRef }
  | { readonly code: 'invalid-signature'; readonly certificate: CertificateRef }
  | { readonly code: 'name-mismatch' }
  | { readonly code: 'no-path-to-trust-anchor' }
  | { readonly code: 'maximum-chain-depth-exceeded' }
  /**
   * The chain builds and verifies, and the root that anchors it was distrusted
   * for certificates issued this recently. Distinct from
   * `no-path-to-trust-anchor` because the diagnosis is completely different:
   * the CA is one we know and shipped, and the answer is that the mail host
   * needs a certificate from someone else — not that we cannot find its issuer.
   */
  | { readonly code: 'certificate-authority-distrusted'; readonly certificate: CertificateRef }
  /**
   * A `Validator` refused for a reason that is not a property of the chain.
   * Every other code above names something path validation CONCLUDED — an
   * expiry, a constraint, a signature — and a refusal that is not about the
   * chain has nowhere else to sit, so it borrows one and lies about why.
   *
   * `YOZZ_VALIDATOR` never returns this; it is for a validator layered over
   * one. Trust-on-first-use is the case it exists for: a pin mismatch means
   * the chain validated and the key still is not the one we saw before, which
   * is not an expiry or a constraint or a broken signature.
   *
   * It carries nothing on purpose. Whoever returns it raised the refusal and
   * already knows the detail; nothing downstream reads one.
   */
  | { readonly code: 'rejected-by-policy' };

/**
 * A path, not a boolean. `tls` has to verify `CertificateVerify` with the LEAF's
 * key, so a boolean would send it back to parse the peer certificate again —
 * a second certificate parser in the security path, which is the thing to avoid.
 *
 * It carries SPKI **DER** rather than a `CryptoKey` for the mirror-image reason:
 * the same RSA key imports differently depending on which scheme the server
 * chose — `rsa_pss_rsae_sha256` and `rsa_pss_rsae_sha384` want RSA-PSS with a
 * different hash, and WebCrypto binds the hash at import. That choice arrives in
 * `CertificateVerify`, on the wire, where this package cannot see it. So `tls`
 * owns the `importKey`. Handing back a ready-made key would bake one import
 * choice into a package that cannot know which is right.
 *
 * (PKCS#1 v1.5 is deliberately not in that list: TLS 1.3 defines those
 * codepoints for signatures in CERTIFICATES only, never for `CertificateVerify`,
 * which is why the client advertises the two PSS variants and nothing else.)
 */
export type ValidatedPath = {
  readonly leafSubjectPublicKeyInfoDer: Uint8Array;
  readonly intermediates: readonly Uint8Array[];
  readonly trustAnchorId: string;
};

export type PathValidationResult =
  | { readonly ok: true; readonly path: ValidatedPath }
  | { readonly ok: false; readonly reason: ValidationFailure };

/**
 * What the harness drives. One implementation at M1 (OpenSSL, the control);
 * `@yozz.app/x509` becomes the second at M4.
 */
export type Validator = {
  readonly name: string;
  readonly validatePath: (request: PathValidationRequest) => Promise<PathValidationResult>;
};
