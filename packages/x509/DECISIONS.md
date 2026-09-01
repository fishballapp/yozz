# Decisions

Why the code is shaped the way it is. Append-only; supersede an entry rather than editing it.

## DER

### Nodes are views, and every length is compared before anything is read

`Uint8Array.prototype.slice` clamps: a TLV declaring 900 bytes with 9 present yields a 9-byte value
and no error. Every length-driven read in `der.ts` compares the declared length against the
enclosing bound first, and nodes hold `subarray` views rather than copies. Retaining
`tbsCertificate` verbatim for signature verification falls out of that for free, and nothing is
ever allocated on a declared length.

### The decoder throws `DerError` and nothing else

`validate.ts` catches it once and maps it to `malformed-certificate`, so `@yozz.app/tls` has one
failure path. The fuzz gate asserts every throw is a `DerError`: a `TypeError`, a `RangeError` from
stack exhaustion, or an OOM is a bug. That is why depth, node count, length octets, tag octets and
OID subidentifier octets each carry an explicit bound, and why every bound fires long before V8's
own limits.

### Recursion follows the constructed bit, never a schema

A BIT STRING holding an SPKI, or an OCTET STRING holding an extension value, stops at the DER
layer and `certificate.ts` re-enters it deliberately with `decodeDer(node.content)`. From the
outside DER is indistinguishable from any other bytes, and a decoder that guesses is one an
attacker steers.

### Unrecognised universal tags are rejected; three string types stay untested

The X.509 type universe is fixed, so the smallest accepting surface is the right one. TeletexString,
UniversalString and BMPString are legal `DirectoryString` choices (RFC 5280 §4.1.2.4) and stay in
the table, but neither corpus exercises them: 706 sampled x509-limbo certificates and all 59
harvested ones use only PrintableString, UTF8String, IA5String, UTCTime and GeneralizedTime.

### Calendar fields are checked before a `Date` is built

`new Date('2024-02-30T00:00:00Z')` returns March 1st. Left to the constructor, a malformed
`notAfter` buys a day of validity and disagrees with OpenSSL, which is a verdict flip under
x509-limbo.

## Certificate structure

### Extensions are kept as bytes until something reads them

Entrust's private extension `1.2.840.113533.7.65.0` holds a GeneralString, which RFC 5280 admits
nowhere. Eagerly decoding every extension rejected a root that Node and every browser trust. Only
recognised extensions are decoded.

### The decoder keeps attacker-controlled fields verbatim

A dNSName with an embedded NUL comes back with the NUL in it. `evil.com\0.good.com` truncated at
decode is how a name check gets fooled by a string the CA never issued; refusing it is the
matcher's job, and it can only do that if the bytes reach it intact. For the same reason the
outer and inner `AlgorithmIdentifier` must match (RFC 5280 §4.1.1.2): the outer one is unsigned.

## Path validation

### Path building is a search with a step budget

A subject name can be issued by several keys (a cross-sign), so one failing chain says nothing
about another. `pathological::pathological-chain-*` supplies 100 distinct intermediates that all
chain, so even an acyclic search explores combinatorially many orderings before any path
finishes. The budget counts steps, not finished paths. Real WebPKI chains are three or four links
from a handful of candidates; if a legitimate cross-signed graph ever exhausts it, order
candidates by authority key identifier before raising the number.

### An anchor is validated as a certificate, because x509-limbo says so

RFC 5280 §6.1 treats a trust anchor as a name and a key. x509-limbo expects an expired root, a
root without basic constraints, a root whose `cA` bit and `keyCertSign` disagree, and a root
carrying an unknown critical extension each to fail, and this validator follows limbo. The
anchor's own `pathLenConstraint` binds the path for the same reason.

Two rules that looked like one cost two valid chains when folded together: a stated authority key
identifier must always name a key, but only a non-anchor must state one at all. Demanding it of
an anchor rejects `cve::cve-2024-0567` and `rfc5280::root-and-intermediate-swapped`. Likewise a
self-signed anchor's authority key identifier must name its own key, but an intermediate placed in
a trust store correctly names the root above it.

### Name chaining compares bytes; name constraints compare canonically

CABF requires a certificate's issuer field to be byte-identical to its CA's subject, so comparing
canonically when chaining would build chains the profile forbids. A miss when chaining costs a
rejection; a miss in a name constraint costs an authorisation. The two want opposite defaults.

### A CA that states an EKU has constrained itself

Without carrying the CA's EKU down to the leaf, a trusted CA key restricted away from
`serverAuth` still lets its holder impersonate a mail server. The six `bettertls::pathbuilding`
BAD_EKU cases are that. `anyExtendedKeyUsage` is accepted on a CA as a statement of breadth, and
refused on a leaf (CABF 7.1.2.7.10) as a refusal to be specific.

### Mozilla's distrust-after is compared against the leaf

A root program retires a CA by refusing what it issues from a date onward, not by removing it.
Certificates already issued were issued in good faith and keep working until they expire, so
dropping the root outright would refuse chains every browser still accepts for the life of a
leaf. The cutoff is compared against the leaf's `notBefore`, not an intermediate's (those are
reissued on the CA's schedule), and after the chain has verified, so a broken chain gets a better
diagnosis than "distrusted CA". The cutoff comes from NSS `certdata.txt` at build time because
`cacert.pem` cannot carry it, and the field is required on `TrustAnchor` so a source cannot forget it.

### The name-comparison budget is a security control

`pathological::nc-dos-1` presents 2048 SANs against 4097 subtrees, 8.4 million comparisons for
an otherwise valid chain, and x509-limbo expects it refused. rustls-webpki carries the same kind
of bound. Exhausting the budget reads as a refusal: a certificate that could not be cleared was
not cleared.

### Wildcards are asked two different questions by permitted and excluded subtrees

Permitted asks whether everything `*.example.com` can authenticate is inside the subtree, so it
is permitted by `example.com`. Excluded asks whether it can authenticate anything inside the
subtree, so it must be refused by an exclusion of `bar.example.com`. Stripping the wildcard for
both lets a name-constrained CA issue a wildcard covering the host it was forbidden. That is
CVE-2025-61727.

### Directory strings fold with `toLowerCase`, after fatal decoding

An ASCII-only fold left `O=ÉVIL` and `O=évil` as different organisations, so an excluded
directory subtree was evaded by changing case. `toLowerCase` is locale-independent; it is
`toLocaleLowerCase` that maps the Turkish dotted I. Decoding is fatal because a lenient decoder
maps every invalid sequence to U+FFFD and collapses distinct values onto one identity.

### `ValidatedPath` carries SPKI DER, not a `CryptoKey`

The same RSA key imports differently depending on which scheme the server chose:
`rsa_pss_rsae_sha256` and `rsa_pss_rsae_sha384` want RSA-PSS with different hashes, and WebCrypto
binds the hash at import. That choice arrives in `CertificateVerify`, where this package cannot
see it, so `@yozz.app/tls` owns the `importKey`. A path rather than a boolean, because `tls` needs
the leaf key and a second certificate parser in the security path is the thing to avoid.

## Signatures and keys

### The algorithm table is bounded by measurement

Across x509-limbo's 30340 certificates and the 59 harvested from real mail servers and root
stores, exactly six signature algorithms and two key types appear. Everything else (SHA-1, DSA,
ML-DSA) is refused. P-192 is deliberately absent from the curve table so that "the curve is too
small" is a key refusal rather than a verification failure.

### `@yozz.app/tls` advertises exactly this table

`signature_algorithms_cert` (RFC 9846 §4.3.3) is derived from `CERTIFICATE_SIGNATURE_ALGORITHM_OIDS`
and `CERTIFICATE_CURVE_OIDS`. The ClientHello once advertised RSA-PSS and Ed25519, which this
package cannot verify, and never advertised RSA-PKCS1, which signs most of the real WebPKI. A
list in two files was the bug. Under-advertising is safe (a server that finds no match sends its
chain anyway, §4.5.1.2); over-advertising is the failure this replaced, and `tls` has a test for it.

## Trust store

### The index is compiled, and certificates decode lazily

The spike measured 314 ms of a 1376 ms cold load going into parsing a root bundle. The fix is not
a faster parser; it is not parsing 150 roots to find the one that matters. A lookup by issuer
name touches one or two roots. An earlier version decoded the candidate and cached the result,
which nothing read: the validator re-decodes from `certificateDer` regardless.

### `findCandidates` keys on issuer name alone

One name legitimately carries several keys (a cross-sign), and the validator verifies every
candidate it is handed, so narrowing by authority key identifier could only lose a valid path.

## Test support

### `certificate-builder.ts` exists because `pnpm test` had no coverage of `validate.ts`

Two authentication bypasses passed every green gate. The x509-limbo suite is the exhaustive gate
and cannot run in CI; the builder's real, signed chains are the gate that always runs. Its
`keyPair` option reissues over an existing key, which is what a renewal is and what an SPKI pin
must stay silent through.

## Trust-store tooling

### Two pinned inputs, and the second is not optional

`cacert.pem` is NSS filtered to the roots trusted for server authentication, which is the list
YOZZ wants, and reproducing that filter would be how a root nobody meant to trust gets shipped.
But PEM carries no metadata: a root Mozilla has distrusted for certificates issued after a date
looks in the bundle exactly like one it has not, and a root gaining a cutoff does not change the
PEM at all. `certdata.txt` is where the date lives. Measured 2026-08-20: `Izenpe.com` carries a
2026-04-15 server cutoff, is past it, and is still in curl's bundle unannotated. NSS is pinned by
commit, not branch, because a moving trust input is what pinning exists to prevent.

### The cutoff attribute hangs off either object class

On NSS `70a8ff50`, three `CKA_NSS_SERVER_DISTRUST_AFTER` values sit on `CKO_CERTIFICATE` objects
(the Entrust roots, already gone from curl's bundle) and one on a `CKO_NSS_TRUST` object
(`Izenpe.com`, the only root both shipped and past its cutoff). A parser that reads certificate
objects alone finds three and drops exactly the one that matters. `certdata.ts` walks every
object and keys on issuer plus serial, which both classes carry. NSS writes trust objects after
the certificates they belong to, so a file truncated between the two blocks has every
certificate and no cutoffs; the build and the upstream check therefore demand a trust object per
bundle root, not merely a certificate object.

### The build hashes what it compiles

`.anchors/` is a gitignored cache. Bumping `pin.ts` without re-fetching would stamp the artifact
with the new hashes and build it from the old bytes, telling a reviewer it matches something it
was never checked against. The generated header carries measured hashes. A bundle root that
certdata has never heard of fails the build: the two pins are out of step, and every such root
would silently get a `null` cutoff. A certificate that does not decode also fails the build,
unlike at runtime, where `indexAnchors` drops it so one corrupt row cannot take down an unrelated
connection.

### The upstream check reports and never updates

An automated bump would hand whoever controls `curl.se` or the NSS mirror the ability to change
what YOZZ trusts unattended, which is the pin removed rather than strengthened. The cron prints
the diff and the two hashes to paste and exits non-zero. It fetches `master` on purpose (the
question is what upstream says today), resolves the commit that last touched `certdata.txt`
rather than the branch tip (so unrelated NSS commits do not look like trust changes), and never
compiles what it downloads. Roots are matched by certificate DER because the artifact ids are
positional. A certificate subject is attacker-chosen text going into a CI log where `::error::`
is a workflow command, so labels are stripped of control characters and capped.

## Test corpus

### Harvested, not authored, and deduplicated by what makes a certificate interesting

Hand-written certificates encode what we already believe a certificate looks like, which is the
belief the decoder has to be tested against. The corpus comes off real mail servers plus the
Mozilla root store Node ships (servers rarely send their root: 2 of 12 chain tops were
self-signed, and the rare encodings, one GeneralizedTime root and one IA5String DN, live only in
the store). Deduplication is by signature algorithm, key type, extension set and ASN.1
string/time encoding: 215 harvested, 59 kept. Chain position is not part of the key, or a
cross-signed root would be stored twice. A sighting is provenance only when its own hash matches
the entry's; the first manifest claimed rambler.ru served DigiCert Global Root G2, which it does
not. The output is committed, because a gate whose inputs are re-fetched tests the internet.

### The OpenSSL control is isolated and never scores a crash as a rejection

`-trusted` rather than `-CAfile`, because `-CAfile` adds to the host's default store and a
machine with extra CAs would false-accept. `-x509_strict` and `-auth_level 2` enforce what the
CLI is lax about. `openssl verify` falls back to the Common Name when a leaf has no SAN and
cannot be told not to, so the adapter refuses SAN-less leaves itself (RFC 9525; limbo tests it
972 times). A crash, a timeout or a missing binary throws: 8838 cases expect rejection, so a
control that turned every failure into `ok: false` would read as a harsh but working validator
while running nothing. The control's anchor source stays unindexed, since `indexAnchors` drops
roots our decoder cannot read and a control sharing our code is a mirror.

### The declared profile is WebPKI

x509-limbo ships contradictory `rfc5280::` / `webpki::` pairs, so a perfect score does not
exist and whatever gets skipped becomes the profile. `denial-of-service` is not skipped. Only
our own validator is gated on disagreements; OpenSSL's are a measurement.
