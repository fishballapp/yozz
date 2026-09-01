/** x509-limbo ships contradictory `rfc5280::` / `webpki::` pairs, so a profile must be declared. This is a browser-facing client: WebPKI. */
export const PROFILE = 'webpki' as const;

/** Namespaces skipped wholesale, with the reason. */
export const SKIPPED_NAMESPACES: Readonly<Record<string, string>> = {
  online: 'needs network access; the suite is meant to run offline',
};

/** Features skipped, with the reason. Anything absent here RUNS. */
export const SKIPPED_FEATURES: Readonly<Record<string, string>> = {
  'has-crl': 'no revocation checking in v1, stapled or otherwise — an accepted gap',
  'has-mldsa': 'no WebCrypto primitive exists for ML-DSA',
  'has-cert-policies': 'certificate policy validation is not implemented; browsers do not either',
  'has-policy-constraints': 'as above — policy processing is not a mail-server bypass class',
  'rfc5280-incompatible-with-webpki': 'we declare WebPKI, so this case is expected to differ',
  'pedantic-public-suffix-wildcard': 'needs a public suffix list, which we do not ship',
};

/** `denial-of-service` is not skipped: those cases hang a naive implementation. */
export const isSkipped = (id: string, features: readonly string[]): string | undefined => {
  const namespace = id.split('::')[0] ?? '';
  const byNamespace = SKIPPED_NAMESPACES[namespace];
  if (byNamespace !== undefined) return `namespace ${namespace}: ${byNamespace}`;

  for (const feature of features) {
    const byFeature = SKIPPED_FEATURES[feature];
    if (byFeature !== undefined) return `feature ${feature}: ${byFeature}`;
  }

  // The other half of a conflicting pair is an expected mismatch under WebPKI. `pathlen::` states RFC 5280 semantics too.
  const conflict = CONFLICTING_IDS[id];
  if (conflict !== undefined) return `conflicts with ${conflict}; we declared ${PROFILE}`;
  return undefined;
};

/** Each entry names the WebPKI case it contradicts. */
const CONFLICTING_IDS: Readonly<Record<string, string>> = {
  'rfc5280::ca-as-leaf': 'webpki::ca-as-leaf',
  'rfc5280::eku::ee-without-eku': 'webpki::eku::ee-without-eku',
  'rfc5280::nc::permitted-dns-match-noncritical': 'webpki::nc::permitted-dns-match-noncritical',
  // RFC 5280 reads a wildcard SAN as a literal name a dNSName constraint
  // forbids; WebPKI constrains what it EXPANDS to, and permits it.
  'rfc5280::nc::nc-forbids-dnsname-wildcard-san': 'webpki::nc::nc-permits-dns-san-pattern',
  // RFC 5280 s4.2.1.9 says the leaf is definitionally not an intermediate, so a
  // CA in leaf position is fine; CABF 7.1.2.7.8 says cA MUST be false there.
  'pathlen::validation-ignores-pathlen-in-leaf': 'webpki::ca-as-leaf',
};
