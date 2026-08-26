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

**"Passes BoGo" is not a claim on its own.** BoGo covers BoringSSL's whole surface — TLS 1.2,
DTLS, QUIC, client certificates, renegotiation, early data. `-allow-unimplemented` lets an
exit-89 skip *every* test, `DisabledTests` removes the rest and `-loose-errors` hides wrong
alerts, so a green board is reachable with no coverage whatsoever.

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
`-TLS12-` really is TLS 1.2; and the protocol and side arrive from the runner directly, in the
`-write-settings` prefix it hands the shim.

## Status: GREEN, and read the scope before believing it

boringssl `0.20260813.0`, **296 in-scope tests of 7895**:

```
  PASS  296
  FAIL    0
  SKIP    0
```

**Every column but the first is empty.** Nothing in scope is accepted that the suite says to
refuse, nothing in scope is refused that it says to accept, and nothing in scope exits 89. That
is M7's gate met.

**Thirty-three of those tests left by decision, not by being built**, which is
the move this file warns about two sections up — so the number above means nothing without the
rules that produced it. All five are in `scope.ts` with their reasoning, `run.ts` prints them in
full, and **none of them was passing**, so the denominator fell and the measured coverage did
not
([the pass, and what it does to the claim](../../../../DECISIONS.md#the-last-39-bogo-skips-22-built-17-argued-out-and-what-that-does-to-the-gate)).
The gate reported every one as `recorded, not in manifest` before they were re-recorded, which is
the deletion check a cross-model review added earlier doing exactly its job: a scope rule cannot
quietly remove a test that used to be measured.

**One finding came out of that pass and outweighs the tests it closed.** Reading RFC 9846 §4.3.3
to justify the six legacy schemes is what surfaced that this client sent no
`signature_algorithms_cert` and therefore misstated which certificate signatures it can verify —
a defect that would break a real mail host rather than a test. It is fixed, and fixing it added
18 bytes to the ClientHello, which made `clienthello-too-small-to-pad`'s premise false exactly as
that rule had predicted in writing. RFC 7685 padding is implemented, the rule is gone, and
`ClientHelloPadding` passes ([both](../../../../HANDOFF.md)).

**Re-validating on resume was the last thing BUILT here**, and it took all 16 of the largest
bucket at once.
`-reverify-on-resume` maps to `reverifyOnResume` on `startTls`, which validates the session's
stored chain again against today's clock and today's anchors. The shim passes it **explicitly on
every connection** rather than relying on a default, because the two sides of the board disagree
about what the default should be: BoGo's `CertificateVerificationDoesNotFailOnResume` (24 tests)
requires a default client NOT to re-check, and `startTls` defaults to `true` because YOZZ wants
the check ([why](../../../../DECISIONS.md#a-resumed-handshake-re-checks-the-stored-chain-and-a-failure-is-a-refusal)).
The manifest was rebuilt for the new flag and did not move: unlike `-curves` and `-resume-count`,
a client-side verification flag reveals nothing about the peer's version.

**ECH, ML-KEM and P-521 left the board by decision, not by code** — 87 tests, none of them
passing, now three rules in `scope.ts`
([why](../../../../DECISIONS.md#ech-ml-kem-and-p-521-are-out-of-v1-and-only-one-of-the-three-is-close)).
Writing them is the clearest case yet for reading `InventoryRow.argv` rather than the shim's
decline reason: the backlog's buckets named 75 tests and the rules took 87, because thirteen
asked for ECH or an ML-KEM group while declining on some *other* flag first.

**The signature algorithms landed here.** `-verify-prefs` sets what
`signature_algorithms` offers and `-expect-peer-signature-algorithm` reads back the scheme the
server signed with, so 31 tests moved at once — the whole `Client-Verify` /
`Client-VerifyDefault` table plus the four `VerifyPreferences` tests. It cost one scheme
(`rsa_pss_rsae_sha512`, which BoGo requires a default-capable client to accept and this one did
not implement) and one new rule in the client: a CertificateVerify signed with a scheme we did
not offer is now `illegal_parameter`, per RFC 9846 §4.5.2.

**Resumption landed here too.** The in-scope count FELL from 466 while the passes rose from
167, which is the rule below doing its job: teaching the shim `-resume-count` let 34 TLS 1.2
tests reach version negotiation for the first time, and `pre-tls13-by-peer` moved every one of
them out. Four tests came back the other way — the `awaits-resumption` rule is gone, because
the runner only ever sends a `NewSessionTicket` to a client that offered
`psk_key_exchange_modes`.

**A skip is attributed to the missing THING, not to the flag that carried it.** `-curves`
declined 53 tests as one bucket, which read as "we do not parse a flag" when 34 of them wanted
P-521 or an ML-KEM group. `-verify-prefs` did the same to 32 more. The shim now declines both by
ALGORITHM name, so the report separates harness work from a curve or a signature scheme we have
not implemented — and it is precise enough to be worth reading: the ten schemes in the backlog
are six that TLS 1.3 removed from CertificateVerify anyway, P-521, and the three ML-DSA sizes.

## Rebuild the manifest when the SHIM grows, not only when the pin moves

`pre-tls13-by-peer` classifies a test by what the peer did to us, and **a test the shim skips
tells it nothing** — the shim exits before version negotiation ever happens. So a flag the shim
learns can reveal that a test in the manifest was never ours.

It has happened four times. `CheckLeafCurve` and `UnsupportedCurve` are `MaxVersion:
VersionTLS12` tests that sat in scope only because `-curves` made them exit 89 before the
runner could refuse our TLS-1.3-only ClientHello. Teaching the shim `-curves` turned them into
two failures that were never in scope, and `bogo:inventory` moved them out. `-resume-count`
then did the same for 34 more, and `-expect-peer-signature-algorithm` for one —
`Client-VerifyDefault-Ed25519-TLS13`, the sigalg table's twin of a BoringSSL default-policy test
`not-our-clienthello` already excluded by name.

**The fourth time was not the version rule at all, and it is the one to learn from.** Six
`CBCRecordSplitting*` tests run at `MaxVersion: VersionTLS10` (`cbc_tests.go`) and eight
`NPN-Client-ClientSelectEmpty-*` at `VersionTLS12` (`state_machine_tests.go`), and neither was
waiting on a measurement — CBC record splitting is a cipher mode TLS 1.3 does not have, and NPN
is what ALPN replaced. The `alpn` rule read `-select-next-proto` by name and never saw
`-select-empty-next-proto`; the CBC six were attributed to `-write-different-record-sizes`, the
first flag the shim met, when what actually put them out of scope was
`-cbc-record-splitting` sitting behind it. **So the backlog's own attribution can hide a scope
rule**, and the fix was to read the flag list rather than trust the first name in it.

Two files record an agreement, and neither is a shortcut. `ErrorMap` in
[shim-config.json](shim-config.json) says "the alert we send is the one RFC 9846 names for this
condition" — a bad `CertificateVerify` really is `decrypt_error`, an unsolicited extension
really is `unsupported_extension`. `RFC_DIVERGENCES` in [scope.ts](scope.ts) says "the RFC is
explicitly on our side and BoringSSL chose otherwise", and every entry quotes the sentence it
rests on. A divergence list is exactly where a bug hides, so an entry without its citation is
not an entry.

`ClientHelloPadding` used to sit in a third category — neither in scope nor backlog — and the
story of how it left is worth keeping, because the rule that excluded it predicted its own end.
The test asks for a ClientHello of exactly 512 bytes, the size RFC 7685's example reaches for a
message that would otherwise land in the 256..511 range an F5 terminator hangs on, and it picks
an 84-character hostname to push BoringSSL into that range. **BoringSSL's extension list is much
larger than ours**, so with the same hostname this client's ClientHello was **255 bytes** — one
short — and the rule said in as many words that any further extension would make its premise
false.

`signature_algorithms_cert` was that extension. It costs 18 bytes, the ClientHello became **273**,
and the condition the test exists for became reachable. So RFC 7685 §4 is implemented, the rule
is deleted, and the test PASSES. Two mutations fail it: never padding, and forgetting that "a
padding extension of length zero adds 4 bytes to the ClientHello". Real hostnames are nowhere
near the range — measured against five live mail hosts, 202 to 214 bytes — so the padding is for
long names and ticket-carrying hellos.

**A rule that names the measurement that would falsify it is worth the words.** This one carried
its own margin (255, then 253, then 247 going backwards through the extensions that had eaten it)
and the exact edit that would break it. When that edit came, nothing had to be rediscovered.

**Some of the backlog is the shim's, not the client's.** `-async` and `-implicit-handshake`
describe how BoringSSL's own shim drives its API and are invisible on the wire, so this shim
accepts and ignores them; `-shim-writes-first`, `-shim-shuts-down` and `-check-close-notify` are
behaviours it now has. That is worth separating from the client's backlog, because a skip that
only ever needed twenty lines of harness is not the same debt as ECH. The 27 remaining under
`per-connection flag scoping` are the clearest case: BoGo can aim a flag at one connection of a
resumption run with an `-on-initial-` / `-on-resume-` prefix, and the shim declines the whole
mechanism by name rather than by whichever flag carried the prefix — otherwise
`-on-resume-verify-fail` reads as "we cannot fail verification", which we can.

**The shim's clock is a mock, and it has to be.** BoGo compares the ticket age the client
reports against `-resumption-delay` for EXACT equality (`ExpectTicketAge` in
`handshake_server.go`), so real time elapsing between two connections fails the test by however
long the exchange took. BoringSSL's own shim freezes at `{1234, 1234}` and advances only between
connections; ours starts from the real clock instead and advances the same way, because the same
value dates certificate validation and a 1970 epoch expires every chain BoGo issues.

**A scope rule that depends on our own behaviour has to be measured twice.** `pre-tls13-by-peer`
reads the runner's complaint out of a FAILING test, and for a while that was all it read — so
when a fix changed which error we raise, fifteen TLS 1.2 tests started PASSING on an error our
client raised for its own reasons and walked into the manifest as coverage. Nothing about
`SkipServerKeyExchange` was being tested by any of them. The rule now also counts the client's
own `alert-received protocol_version`, which is what a 1.2-only server actually sends us.

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
