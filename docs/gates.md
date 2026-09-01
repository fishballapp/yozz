# YOZZ gates — every check, and what it must say

`pnpm check` + `pnpm test` from the repo root are the floor. The suites below are the ones a
change to a specific package also owes, and the numbers a green run is expected to print. **If
a number moves, something changed underneath — find out what before updating it here.**

## In `pnpm test`

```bash
pnpm -F @yozz.app/vault test            # 47. The key schedule + record crypto. No network, no storage.
                                    #   The OpenSSL control lives here: node:crypto re-derives the
                                    #   whole schedule and opens a real record
pnpm -F @yozz.app/vault-contract test   # 26. The wire schemas, incl. the strict refusal of
                                    #   `revision`, `deviceId`, plaintext and secrets
pnpm -F @yozz.app/worker-api test       # 26. Against an ISOLATED LOCAL D1 with every migration
                                    #   applied; migrations.test.ts pins vault_record's exact
                                    #   column list, so a new plaintext column is a red test
pnpm -F @yozz.app/web test              # 298. Vault client + unlock (WebAuthn mocked), mail MIME,
                                    #   the WebMCP tools over a fake port + their mount, draft
                                    #   records under CAS, the send state machine and the draft
                                    #   mirror, ceilings, sanitizer policy and image consent
pnpm -F @yozz.app/x509 test             # 426, incl. end-to-end chains signed at test time and the
                                    #   two authentication bypasses as regressions
pnpm -F @yozz.app/tls test              # 455. RFC 8448 byte-exact on all five traces; the interop
                                    #   rows open loopback sockets
pnpm -F @yozz.app/worker-api db:check-auth   # fails if the generated Better Auth migration has
                                    #   drifted from the plugin set. Run after any auth.ts change
```

## Owed when touching `packages/x509` or `packages/tls`

Neither is in `pnpm test` — limbo needs a 39MB corpus and BoGo a Go toolchain plus a pinned
BoringSSL checkout — so both fetch once and then run offline. CI runs them on every push that
touches either package (`_yozz-gates.yml`). Run them yourself anyway: two authentication bypasses
shipped in `@yozz.app/x509` while limbo was a command someone had to remember.

```bash
pnpm -F @yozz.app/x509 limbo:fetch      # 39MB, pinned + SHA-256 verified into gitignored .limbo/
pnpm -F @yozz.app/x509 limbo:ours       # @yozz.app/x509 itself, ~4s. Exits non-zero if the set of
                                    #   disagreements differs from harness/expected-disagreements.txt
                                    #   in EITHER direction
pnpm -F @yozz.app/x509 limbo            # the OpenSSL control, for the comparison row
node packages/x509/harness/limbo.ts --validator=yozz --anchors=unindexed   # the M5 gate: the
                                    #   plain anchor source must score identically to the compiled one

pnpm -F @yozz.app/tls bogo:fetch        # the pinned boringssl checkout, 337MB, into gitignored .bogo/
pnpm -F @yozz.app/tls bogo              # 296 in-scope tests, ~15s. Needs Go
pnpm -F @yozz.app/tls bogo:record       # re-record expected.txt after a fix or a pin bump
pnpm -F @yozz.app/tls bogo:inventory    # ~3.5min. REBUILD manifest.txt after a pin bump or after the
                                    #   shim learns a flag. Run it alone, never through `head`:
                                    #   a truncated sweep is refused (BORINGSSL_TEST_COUNT in pin.ts)
```

| | must ACCEPT | must REJECT | disagreements |
| --- | --- | --- | --- |
| `@yozz.app/x509` | **902/902** | **8827/8837** | **10** — each attributed in `expected-disagreements.txt` |
| OpenSSL 3.6.3 (control) | 784/902 | 8765/8837 | 190 |
| `@yozz.app/tls` BoGo | 296 pass | 0 fail | 0 skip — every exclusion is a rule in `harness/bogo/scope.ts` |

All ten x509 disagreements are over-ACCEPTS, the dangerous direction for a verifier. Treat the
count as debt, not a score.

## The vault in a real browser

```bash
pnpm -F @yozz.app/web vault:drive       # both unlock modes through headless Chromium against wrangler
                                    #   dev + local D1, incl. a real WebAuthn PRF ceremony on CDP's
                                    #   virtual authenticator. Needs both dev servers up
                                    #   (AGENTS.md, "Running the vault locally"). 13 steps, all ✓
```

## A vault draft in the composer

```bash
pnpm -F @yozz.app/web draft:drive       # writes a draft record the way `save_draft` does, then opens it
                                    #   both ways a user can: a fresh load of `?compose=draft:<key>`
                                    #   and a client-side navigation from the Drafts list. Reads the
                                    #   To/Subject/Body back as both DOM property and attribute, since
                                    #   an agent reading a page snapshot only ever sees the attribute.
                                    #   Same dev servers as `vault:drive`.
```

## Received HTML in real browsers

```bash
pnpm -F @yozz.app/web html:security     # Chromium + Firefox + WebKit: loads the real sanitizer module
                                    #   under public/_headers' host CSP, then proves the srcdoc CSP,
                                    #   positive frame auto-sizing, opaque sandbox, script stripping,
                                    #   URL-bearing CSS removal, outward-link isolation and
                                    #   referrer-free image opt-in; direct DOM probes prove the
                                    #   child CSP independently blocks unlisted images and scripts;
                                    #   build first, because it also rejects inline scripts in dist.
```

This gate runs in `_yozz-gates.yml` on every code push touching YOZZ. It needs
`pnpm -F @yozz.app/web exec playwright install chromium firefox webkit` once on a new machine; CI
derives the installed Playwright version and caches those exact browser binaries against it.

## Network, by hand, never CI

```bash
pnpm -F @yozz.app/smtp live             # nine submission hosts over 465: banner + EHLO. 9/9 ok. With
                                    #   YOZZ_SMTP_HOST/USER/PASSWORD(/TO): auth, then one real send
pnpm -F @yozz.app/tls live              # nine mail servers over node:net; prints each host's SPKI pin.
                                    #   Takes host names to run fewer. A red line is usually THEIR outage
pnpm -F @yozz.app/tls browser           # the same nine in Chromium, Gecko and WebKit over a WebSocket
                                    #   to the spike Worker under local workerd. Needs
                                    #   `playwright install`, no Cloudflare credential.
                                    #   --engine webkit for one; --bridge wss://… for a deployed relay.
                                    #   Exits non-zero if the engines derive different pins for a host

pnpm -F @yozz.app/x509 anchors:fetch    # curl's cacert.pem + NSS certdata.txt, pinned by SHA-256 into
                                    #   gitignored .anchors/. A hash mismatch is a TRUST CHANGE —
                                    #   read what moved before pasting a new hash
pnpm -F @yozz.app/x509 anchors:build    # recompile src/root-bundle-generated.ts (COMMITTED)
pnpm -F @yozz.app/x509 anchors:check    # upstream today vs what we ship; the daily cron
                                    #   (yozz-trust-store.yml) runs exactly this
pnpm -F @yozz.app/x509 corpus:harvest   # only to REBUILD the corpus — network + openssl
pnpm -F @yozz.app/worker-api db:migrate:local   # apply migrations to wrangler dev's local D1
```

Expect 63 handshakes, 63 IMAP greetings from `live` + `browser` together. `posteo.de` takes a
HelloRetryRequest to secp384r1; the other eight take X25519; none offers P-521.

## Mutation discipline

A security change is not done until its mutation bites: apply one mutation, run the focused
suite, confirm it goes red, revert. A test that stays green under the mutation it was written for
measures nothing. The vault, BoGo and pinning suites were all built this way.
