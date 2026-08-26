# The x509-limbo harness

Runs [x509-limbo](../../../../../docs/knowledge/x509-validation-testing.md) against a
`Validator` and reports the accept and reject rates **apart**, because 926 of the relevant
cases expect SUCCESS and a single number hides a validator that rejects everything.

```bash
pnpm -F @yozz.app/x509 limbo:fetch   # pinned commit, SHA-256 verified, into gitignored .limbo/
pnpm -F @yozz.app/x509 limbo         # run it
```

| File | |
| --- | --- |
| `pin.ts` | the pinned commit + hash. 39MB does not go in git, and an unpinned suite silently changes what "green" means |
| `profile.ts` | **the declared profile (WebPKI)** and every skip, each with its reason |
| `openssl.ts` | the control — `openssl verify` behind the same `PathValidationRequest` our own validator will implement |
| `limbo.ts` | the runner |

## Status: calibrated. M1's harness is proven.

**The harness, not the milestone.** M1 is closed now: its last debt, the BoGo shim, is built
and running at [`packages/tls/harness/bogo/`](../../tls/harness/bogo/README.md). The
[certificate corpus](../corpus/README.md) is done, and [HANDOFF.md](../../../HANDOFF.md) tracks
what is actually finished.

**Anchors arrive through the request**, as a `TrustAnchorSource` built per testcase. It is
unindexed — it answers any query with that case's whole root set — which the contract permits,
and which is why `openssl.ts` can ask for everything without a decoder to name an issuer. The
PEM/DER round trip that costs is lossless over all 9780 trusted certificates in the pinned
corpus. Note the runner compares only `ok`, so on a FAILURE-expected case a corrupted anchor
would still reject and still read as agreement — the round trip is the evidence, not the score.

Run against OpenSSL 3.6.3, diffed case-by-case against **x509-limbo's own published anomaly
list for that same version** (248 cases):

```
9786 testcases, 9776 SERVER, 9739 executed, 37 skipped
must ACCEPT   784/902  (86.9%)
must REJECT  8765/8837 (99.2%)

190 disagreements, against their 248
```

The split was derived by hand at M1 against the published list, when the run was
`785/903`, `8765/8838` and **191** disagreements: 185 flagged by both, 6 ours only
and every one attributed, 63 theirs only where our adapter is stricter than raw
OpenSSL. Two cases have since become declared conflicts in
[`profile.ts`](profile.ts) and are skipped, and exactly one of them was in that
191 — so today's 190 is `184/6/63` or `185/5/63`, and **which** is `[unverified]`:
re-deriving it needs the published list, which is not part of the pinned corpus.
The headline numbers above are measured.

**185 identical flags is the result that matters.** The first run scored 242 disagreements with
21 cases nobody else flagged; three findings closed the gap, and none of them was guessable.

**1. CN fallback (fixed in the adapter).** `openssl verify` falls back to the Common Name when a
leaf has no `subjectAltName`, with no flag to stop it. RFC 9525 — the profile we declared —
forbids that, and limbo tests it **972 times**. `openssl.ts` applies the rule before shelling
out. Those cases are most of the 63 theirs-only: they flag OpenSSL for accepting; we do not,
because we already rejected.

**2. `-x509_strict` and `-auth_level 2` (added).** Without them the CLI accepts missing AKI/SKI,
non-critical `basicConstraints` on a CA, P-192 keys and weak RSA — all of which our profile
must reject. Adding both took ours-only from 21 to 6.

**3. The six that remain, each explained:**

| Case | Why |
| --- | --- |
| `pathlen::max-chain-depth-0-exhausted`, `-1-exhausted` | `maximumIntermediateCount` is not passed. `-verify_depth` **does** exist — this is unfinished, not impossible |
| `rfc5280::eku::ee-wrong-eku` | `requiredExtendedKeyUsages` is not passed to the CLI |
| `cve::cve-2024-0567`, `rfc5280::root-and-intermediate-swapped` | chain **building**: the CLI's builder gives up where libcrypto with explicit params succeeds |
| `webpki::san::wildcard-embedded-leftmost-san` | wildcard-matching pedantry |

**So the harness plumbing is proven** — the filter, the field mapping, the PEM/DER round trip,
the verdict comparison — and every residual is a named property of driving OpenSSL through its
CLI rather than a bug in the runner.

## What the control could NOT exercise

**M4 is built, and closed the first item: `@yozz.app/x509` reads
`maximumIntermediateCount`, `requiredKeyUsages` and `requiredExtendedKeyUsages`,
so those three are no longer shape-untested.** Everything below is still true of
the CONTROL, which is what this file is about — a control's limits do not expire
when the thing it controls gets written.

A fresh-context review found these; they are the difference between "the harness agrees with
OpenSSL" and "the harness is ready to judge our own validator".

**Four request fields are carried and then ignored** by the adapter: `maximumIntermediateCount`
(`-verify_depth` exists and is unused), `requiredKeyUsages`, `requiredExtendedKeyUsages`
(`X509_STORE_CTX_set_purpose` in the official harness), and the null-`validation_time` case,
which should mean *do not check time* (`-no_check_time`) rather than "use the wall clock" as it
does today. 166 cases have a null time; none of them flips on this pin, but a later one will.

**Unknown `features[]` run rather than skip.** `profile.ts` is allow-by-omission, where the
suite's own instruction is to skip features you do not understand. A future feature on a
`FAILURE` case plus an "I don't implement that" rejection reads as agreement.

The SAN check in `openssl.ts` is also a 3-byte scan for the extension OID — `55 1d 11` anywhere
in the DER, including inside a signature or modulus, suppresses the CN-fallback rejection. It is
the control adapter; `@yozz.app/x509` is what gets a real decoder.
