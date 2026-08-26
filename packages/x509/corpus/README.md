# The certificate corpus

**59 real certificates, deduplicated from 215.** What M2's decoder and M3's field-for-field
differential run against. Committed, so the gate does not test the internet.

```bash
pnpm -F @yozz.app/x509 corpus:harvest   # network + openssl; run by hand, never in CI
pnpm -F @yozz.app/x509 test             # what guards the corpus itself
```

| File | |
| --- | --- |
| `certs/*.der` | the certificates, DER as they arrived — DER is what the decoder eats, so nothing is re-encoded on the way in |
| `manifest.gen.json` | per certificate: hash, subject, fingerprint, and every place the harvest saw that fingerprint |
| `harvest.ts` | the harvester and its target list |
| `load.ts` | `loadCorpus()`, `provenanceOf()`, the shape, and the guards against an emptied manifest |
| `corpus.test.ts` | the diversity floors |

## Harvested, not authored

A hand-written certificate encodes what we already believe a certificate looks like, which is
exactly the belief under test. These come off 34 live mail hosts — the
[nine from stage 3](../../../ARCHITECTURE.md#stage-3-result-passed) widened across Europe, China,
Korea, Russia and Australia to widen the **CAs**, which is the axis that actually varies — plus
the 120-root Mozilla store Node ships.

**The root store is half the value, and it is not padding.** Servers rarely send their root: of
the 12 distinct chain-top certificates the 34 hosts presented, **10 were not self-signed at
all**. Without
the store the corpus would be almost entirely leaves and intermediates. It also holds the only
two certificates on either side of the harvest that a naive decoder gets wrong — one dated in
`GeneralizedTime`, one with an `IA5String` in its DN — and `corpus.test.ts` asserts both by name
rather than trusting a diversity count to notice their loss.

## What deduplicates a certificate

Four axes, all content: **signature algorithm, key type, extension set, and ASN.1 string and
time encoding**. Two certificates agreeing on all four decode along the same paths, so the second
buys the decoder nothing — 215 in, 59 kept.

**Chain position is deliberately not an axis.** It belongs to the chain that presented the
certificate, not to the certificate, and folding it in stored one cross-signed root twice: once
as a root, once as the intermediate another host serves it as. Position is recorded per source
instead, and it means **self-signed** — not "last in the chain", which is the wrong answer on
most of the web.

### `seenAt` is not provenance until you check the hash

Deduplication is by fingerprint, so the certificate collapsing into an entry is **usually not
that entry's bytes** — 33 of the 59 entries stand in for others, and 116 distinct certificates
were seen and not stored. Every sighting therefore carries **its own `sha256`**: one equal to
the entry's is where these bytes came from, and any other is a certificate dropped for being
uninteresting. `provenanceOf(entry)` is the filtered view, and it is what the tests count.

Read `seenAt` as a source list without checking the hash and you get claims like *"rambler.ru
served DigiCert Global Root G2"* — it serves GlobalSign Root CA R3, whose bytes are not in this
corpus at all. That claim was in the first version of this file.

Nothing is dropped silently: a deduplicated certificate keeps its hash and its sighting, and an
unreachable host is recorded with its reason, because a missing CA should read as a host that
was down rather than as a harvest bug.

## What it spans

| | |
| --- | --- |
| Signature algorithms | 7 — RSA with SHA-1/256/384/512, ECDSA with SHA-256/384/512 |
| Keys | 6 — RSA 2048/3072/4096, P-256, P-384, P-521 |
| Extension sets | 18 distinct, from 2 extensions to 11 |
| Encodings | `PrintableString`, `UTF8String`, `IA5String`; `UTCTime` and `GeneralizedTime` |
| Positions | 12 leaf, 11 intermediate, 36 self-signed root |
| Chain shapes | presented chains of 2, 3 and 4 |

Positions and chain shapes are counted over `provenanceOf` — the sightings that really are the
stored bytes — never over every sighting, which would claim coverage from certificates the
corpus does not hold.

The floors in `corpus.test.ts` sit just under each of these. They exist to fail when a re-harvest
quietly narrows the corpus, which is the only way these files rot. **Raising a floor means
widening `TARGETS` first** — never lowering the floor to fit what came back.

## Two limits, stated so they are not mistaken for coverage

- **`asn1parse` is read for top-level TLVs only**, so `IA5String`s nested inside the SAN's
  `OCTET STRING` do not appear in a fingerprint. Subject and issuer names and the validity times
  all sit at that level, and they are what varies between issuers.
- **RSASSA-PSS is fingerprinted by its parameters**, not just its name, because OpenSSL prints
  `Signature Algorithm: rsassaPss` alone on the header line and puts the hash, MGF and salt
  length on continuation lines — so PSS-SHA256 and PSS-SHA512 would otherwise be one fingerprint
  and one of them would be dropped. Nothing in today's corpus is PSS; the handling is there for
  the re-harvest where that changes.
- **Every certificate here is well-formed**, because every one of them was accepted by a real
  server or shipped in a root store. This corpus proves the decoder *reads* certificates; it says
  nothing about what it *rejects*. The reject-list — BER indefinite lengths, non-minimal lengths,
  unbounded nesting, trailing data — is authored, not harvested, and is
  [`der.test.ts`](../src/der.test.ts). The private-CA defect
  corpus stays where it is, in
  [`make-test-certs.sh`](../../../spikes/relay/make-test-certs.sh).

Certificates expire and that is fine: M2 decodes DER and M3 diffs fields, and neither checks time.
