# The BoGo harness

[BoGo](../../../../../../docs/knowledge/x509-validation-testing.md#bogo) is BoringSSL's TLS
conformance runner. It does not link our code — it drives a **shim**, a program wrapping the
stack under test, and reports pass by exit code.

```bash
pnpm -F @yozz.app/tls bogo:fetch       # the pinned boringssl checkout, into gitignored .bogo/
pnpm -F @yozz.app/tls bogo             # the gate: manifest.txt against expected.txt. ~15s
pnpm -F @yozz.app/tls bogo:record      # re-record expected.txt after a fix or a pin bump
pnpm -F @yozz.app/tls bogo:inventory   # sweep all 7895 tests and rebuild manifest.txt. ~3.5min
```

| File | |
| --- | --- |
| `pin.ts` | the pinned release tag + commit. BoGo ships **inside** BoringSSL and moves with it |
| `shim.ts` | the shim — `startTls` over a socket, one process per test |
| `scope.ts` | **the declared scope**, as rules with reasons. What `manifest.txt` is made of |
| `manifest.txt` | the committed in-scope test names — what the gate runs |
| `expected.txt` | what each of them does today. The gate fails when any of it MOVES |
| `run.ts` | the gate and the inventory run |
| `shim-config.json` | `ErrorMap` — which of our error strings answers which BoringSSL error |

## Why the gate is a manifest

**"Passes BoGo" is not a claim on its own.** BoGo covers BoringSSL's whole surface — pre-1.2 TLS,
legacy TLS 1.2 suites and resumption, DTLS, QUIC, client certificates, renegotiation, early data.
`-allow-unimplemented` lets an exit-89 skip *every* test, `DisabledTests` removes the rest and
`-loose-errors` hides wrong alerts, so a green board is reachable with no coverage whatsoever.

So the gate runs a **committed list of names**, and a second committed file records what each
one does today. **The build asserts that nothing MOVED** — a regression and a fix both land in
the same diff, and both want a look. The milestone's own progress is a separate line, because a
check that cannot pass until the backlog is built is a check everyone learns to scroll past.
`FAIL` is not a value `expected.txt` can hold: a failing test in scope is a defect, a mapping or
a declared divergence, never something to bless by editing a file. A skip is something `shim.ts`
declined, and `run.ts` prints it as debt — by the missing THING, with the count it costs, so a
flag it does not parse and a curve it does not implement are separate lines. The two lists the
milestone asks for are therefore
**out-of-scope-by-design** (`scope.ts`, rules) and **not-implemented-yet** (whatever the gate
reports as SKIP — a backlog, not an excuse).

Two of the scope rules lean on the runner's own invariants rather than on guesses about names:
`checkTests` panics if a versioned or protocol-tagged name disagrees with the test's config, so
`-SSL3-`, `-TLS1-`, `-TLS11-` and `-TLS12-` really match the runner's configured version; and the
protocol and side arrive from the runner directly, in the `-write-settings` prefix it hands the
shim.

## Status: GREEN, and read the scope before believing it

boringssl `0.20260813.0`, **497 in-scope tests of 7895** (TLS 1.3 and modern TLS 1.2 client):

```
  PASS  497
  FAIL    0
  SKIP    0
```

**Every column but the first is empty.** Nothing in scope is accepted that the suite says to
refuse, nothing in scope is refused that it says to accept, and nothing in scope exits 89. All
296 original TLS 1.3 tests remain in the manifest alongside 201 additions: modern TLS 1.2 state
machine, downgrade-sentinel, ECDHE/AES-GCM, Extended Master Secret, warning-alert, and
signature-verification tests, plus three newly active TLS 1.3 extension tests
(`EMS-Forbidden-TLS13`, `RenegotiationInfo-Forbidden-TLS13`, `PointFormat-EncryptedExtensions-TLS13`)
that are now reachable because the default ClientHello advertises TLS 1.2..1.3 extensions.

The scope boundary is declared in [`scope.ts`](scope.ts) and printed in full by `run.ts`:

- **Modern TLS 1.2 only**: ephemeral ECDHE with AES-GCM (`TLS_ECDHE_{ECDSA,RSA}_WITH_AES_{128,256}_GCM_SHA{256,384}`),
  opportunistic Extended Master Secret, no renegotiation (refused with `no_renegotiation`), and no
  TLS 1.2 session resumption. Legacy suites (CBC, 3DES, static RSA, DHE — `tls12-legacy-suites`),
  SHA-1 handshake signatures (`tls12-sha1-signatures`), and TLS 1.2 session-ID/ticket resumption
  (`tls12-resumption`, while cross-version TLS 1.3 → TLS 1.2 rejection tests stay in scope) are
  excluded by design. Because BoGo sets `resumeSession: true` on several positive TLS 1.2 tests
  (`Client-Verify-*-TLS12`, `ExportKeyingMaterial-TLS-TLS12`, per-suite `TLS-TLS12-ECDHE_*-client`),
  positive TLS 1.2 suite, signature-scheme (including RSA-PKCS1), and exporter coverage is gated
  against real OpenSSL in `src/interop.test.ts` and `src/tls12-key-schedule.test.ts`.
- **Pre-TLS 1.2, non-TLS, server, client auth, 0-RTT, ALPN/NPN, ECH, post-quantum, P-521, ChaCha20,
  OCSP stapling, compliance modes, and BoringSSL-specific API/default-policy flags** stay excluded
  under their respective rules in [`scope.ts`](scope.ts)
  ([M7 scope decisions](../../../../DECISIONS.md#the-last-39-bogo-skips-22-built-17-argued-out-and-what-that-does-to-the-gate),
  [ECH / ML-KEM / P-521](../../../../DECISIONS.md#ech-ml-kem-and-p-521-are-out-of-v1-and-only-one-of-the-three-is-close)).
- **Re-validating on resume**: `-reverify-on-resume` maps to `reverifyOnResume` on `startTls`,
  passed explicitly on every connection because BoGo's `CertificateVerificationDoesNotFailOnResume`
  expects `false` by default while `startTls` defaults to `true`
  ([why](../../../../DECISIONS.md#a-resumed-handshake-re-checks-the-stored-chain-and-a-failure-is-a-refusal)).
- **Signature algorithms and ClientHello padding**: `-verify-prefs` maps to `signatureSchemes`
  (covering TLS 1.3 schemes plus `rsa_pkcs1_sha{256,384,512}` for TLS 1.2) and
  `-expect-peer-signature-algorithm` checks `peerSignatureScheme`; RFC 7685 ClientHello padding
  is implemented and `ClientHelloPadding` passes ([notes](../../../../HANDOFF.md)).
- **Five real protocol defects surfaced by expanding BoGo to TLS 1.2** are fixed in `src/` and
  locked with unit regression tests: RFC 8422 §5.1.1 ECDSA leaf-certificate curve checking against
  offered `supported_groups`; checking expected TLS 1.2 handshake message types before decoding the
  body (`unexpected_message` over `decode_error`); tolerating up to 4 consecutive non-`close_notify`
  warning alerts in TLS 1.2 (while keeping TLS 1.3-only strict); accepting F5 BigIP's echoed
  `supported_groups` extension in a TLS 1.2 ServerHello; and sending `illegal_parameter` per
  RFC 9846 §4.2.1 when `supported_versions` in ServerHello carries a pre-TLS 1.3 version.

**A skip is attributed to the missing THING, not to the flag that carried it.** `-curves` and
`-verify-prefs` decline by ALGORITHM name rather than flag name, and `-resume-count` on a TLS 1.2
connection declines as `TLS 1.2 session resumption`, so `bogo:inventory` separates harness flags
from unimplemented algorithms and out-of-scope TLS 1.2 resumption.

## Rebuild the manifest when the SHIM grows, not only when the pin moves

`pre-tls12-by-peer` classifies a test by what the peer did to us, and **a test the shim skips
tells it nothing** — the shim exits before version negotiation ever happens. So a flag the shim
learns can reveal that a test in the manifest was never ours.

Two files record an agreement, and neither is a shortcut. `ErrorMap` in
[shim-config.json](shim-config.json) says "the alert we send is the one the RFC names for this
condition" — a bad `CertificateVerify` or `ServerKeyExchange` signature really is `decrypt_error`,
an unsolicited extension really is `unsupported_extension`. `RFC_DIVERGENCES` in
[scope.ts](scope.ts) says "the RFC is explicitly on our side and BoringSSL chose otherwise", and
every entry quotes the sentence it rests on. A divergence list is exactly where a bug hides, so an
entry without its citation is not an entry.

**The shim's clock is a mock, and it has to be.** BoGo compares the ticket age the client
reports against `-resumption-delay` for EXACT equality (`ExpectTicketAge` in
`handshake_server.go`), so real time elapsing between two connections fails the test by however
long the exchange took. BoringSSL's own shim freezes at `{1234, 1234}` and advances only between
connections; ours starts from the real clock instead and advances the same way, because the same
value dates certificate validation and a 1970 epoch expires every chain BoGo issues.

**A scope rule that depends on our own behaviour has to be measured twice.** `pre-tls12-by-peer`
reads the runner's complaint out of a FAILING test and also counts the client's own
`alert-received protocol_version`, which is what a pre-1.2-only server actually sends us — keeping
accidental passes on older-TLS tests from walking into the manifest as coverage.

## The shim closes its socket gracefully, and waiting for the runner deadlocks

`destroy()` was wrong and cost a fortnight of red CI on a green laptop. Closing a socket that
still holds unread bytes makes the kernel send a RST, which fails the runner's NEXT write with
`broken pipe` — and a runner that reports a failed write never gets as far as reporting the
alert it was about to read, so `remote error: bad record MAC` arrives as a broken pipe.
`AppDataBeforeTLS13KeyChange` is the test that catches it, because its server keeps writing its
flight after the record we refuse; on a fast machine the flight always finished first, so it
passed everywhere except CI.

[`endGracefully`](../socket-transport.ts) drains, flushes and half-closes. **It deliberately does
NOT wait for the runner to close back**: the runner waits for the shim process to EXIT before
closing its side, so waiting is a deadlock that resolves on a timeout — 214 of 296 connections
sat out a two-second grace and turned a 15-second board into 52.

The guard is [`socket-transport.test.ts`](../socket-transport.test.ts), which needs no Go and no
337MB checkout: it leaves data unread, closes, and asserts the peer's next write lands, with a
control asserting `destroy()` fails it.

## The certificates BoGo hands you are not RFC 5280 conformant

`YOZZ_VALIDATOR` refuses **every** certificate the runner offers, so a validating shim runs no
tests at all. BoGo hand-builds its leaves in `ssl/test/runner/certs.go` with an **empty subject
and a non-critical `subjectAltName`**, which RFC 5280 §4.2.1.6 forbids: with no subject the SAN
carries the whole identity, so it has to be critical.

That is not a defect in either side. BoGo tests the state machine, and BoringSSL's own shim does
not verify unless the runner passes `-verify-peer`. Ours matches it: without that flag the shim
supplies a validator that decodes the peer certificate — deliberately corrupt certificates are
still refused, and `CertificateVerify` is still checked against the peer's own SPKI — but does
not build a path. **Path validation is [x509-limbo's](../../../x509/harness/README.md) gate.**
The `-verify-peer` tests are consequently unreachable against this corpus, and sit in the
backlog under that flag rather than being quietly disabled.
