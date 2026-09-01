/**
 * Every input is an argument, trust anchors and time included, so x509-limbo can drive it. Failure
 * is a typed value; a rejected promise is reserved for bugs.
 */

export type PeerName =
  | { readonly kind: 'dns'; readonly value: string }
  | { readonly kind: 'ip'; readonly value: string };

/** May over-approximate, up to the whole store: the validator verifies every candidate. */
export type TrustAnchorSource = {
  readonly findCandidates: (query: {
    readonly issuerNameDer: Uint8Array;
    readonly authorityKeyIdentifier: Uint8Array | null;
  }) => readonly TrustAnchor[];
};

export type TrustAnchor = {
  readonly id: string;
  /** The whole certificate: a root's own constraints and validity are path validation inputs. */
  readonly certificateDer: Uint8Array;
  /** Mozilla's server distrust-after cutoff, compared against the leaf's `notBefore`. Required, so a source cannot forget it. */
  readonly serverDistrustAfter: Date | null;
};

export type PathValidationRequest = {
  readonly peerCertificateDer: Uint8Array;
  readonly untrustedIntermediateDer: readonly Uint8Array[];
  readonly trustAnchors: TrustAnchorSource;
  /** Never the clock. */
  readonly validationTime: Date;
  readonly expectedPeerName: PeerName | null;
  readonly requiredKeyUsages: readonly string[];
  readonly requiredExtendedKeyUsages: readonly string[];
  /** Intermediates, not certificates: 0 permits root -> leaf directly. */
  readonly maximumIntermediateCount: number | null;
};

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
  /** The chain verifies, and its root was distrusted for certificates issued this recently. */
  | { readonly code: 'certificate-authority-distrusted'; readonly certificate: CertificateRef }
  /** A refusal that is not a property of the chain, from a validator layered over this one (a pin mismatch). `YOZZ_VALIDATOR` never returns it. */
  | { readonly code: 'rejected-by-policy' };

/**
 * SPKI DER rather than a `CryptoKey`: WebCrypto binds the hash at import, and which hash is right
 * arrives later in `CertificateVerify`, so `tls` owns the `importKey`.
 */
export type ValidatedPath = {
  readonly leafSubjectPublicKeyInfoDer: Uint8Array;
  readonly intermediates: readonly Uint8Array[];
  readonly trustAnchorId: string;
};

export type PathValidationResult =
  | { readonly ok: true; readonly path: ValidatedPath }
  | { readonly ok: false; readonly reason: ValidationFailure };

export type Validator = {
  readonly name: string;
  readonly validatePath: (request: PathValidationRequest) => Promise<PathValidationResult>;
};
