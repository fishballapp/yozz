# Decisions

Why the code is shaped the way it is. Append-only; supersede an entry rather than editing it.

## Wire

### `signature_algorithms_cert` is derived from `@yozz.app/x509`, never restated

RFC 9846 §4.3.3 separates what may sign a CertificateVerify from what may sign a certificate.
One list for both advertised RSA-PSS and Ed25519, which the validator refuses in a chain, and
withheld RSA-PKCS1, which signs most of the real WebPKI; §4.5.1.2 then told a CA able to present
a PSS chain to prefer the one we would refuse. `CERTIFICATE_SIGNATURE_SCHEMES` is a separate type
so RSA-PKCS1 can never become a CertificateVerify scheme through `signatureSchemeFromCode`, and it
carries OIDs so `wire.test.ts` compares it against x509's own table in both directions. The
extension is read back off a real production ClientHello in that test because a review deleted
it from the builder and nothing noticed.

### Groups, suites and schemes offered

X25519, P-256 and P-384 in that order; P-384 is required because `posteo.de` refuses the other
two. `TLS_AES_128_GCM_SHA256` and `TLS_AES_256_GCM_SHA384` are the two suites real mail providers
need (`posteo.de` takes only the second); ChaCha20 is absent because WebCrypto has none. Ed25519 is
offered for CertificateVerify though BoringSSL disables it by default: a smaller signature over a
curve already carried for key exchange. Only `psk_dhe_ke` is offered, since `psk_ke` gives up
forward secrecy, which is the reason to run our own TLS at all.

### RFC 7685 padding

A ClientHello of 256..511 bytes is padded to 512 because F5 load balancers of a certain vintage
hang on that range, and a mail client dials whatever host a user names. The extension's own
4-byte header counts, so 509..511 take an empty extension and overshoot to 513. A retried
ClientHello may be padded independently (§4.1.2), and a server echoing the extension earns
`illegal_parameter`. This client only reached the range once `signature_algorithms_cert` was
added: BoGo's 84-character `ClientHelloPadding` hostname produced 255 bytes before it and 273
after, which `scope.ts` had predicted.

## Records

### `legacy_record_version` is ignored on plaintext and checked on ciphertext

RFC 9846 §5.1 deprecates the field on a TLSPlaintext and requires it ignored; refusing a record
over it made an SSL 3.0-framed alert (how a server too old for us says so) read as
`decode_error`. On a TLSCiphertext §5.2 says the value is always 0x0303 with no compatibility
concern, so there it is checked. The inner plaintext cap is 2^14 plus the type byte with padding
included: checking content alone let BoGo's `LargePlaintext-TLS13-Padded-16384-1` through.

## Key schedule

### Extract and Expand are HMAC, not WebCrypto's HKDF

WebCrypto's `HKDF` fuses the two and TLS needs them apart. `deriveSecret` takes messages and hashes
them itself because that is the RFC's signature; an earlier shape took a pre-hashed transcript
under the same name, which invites passing `ClientHello ‖ ServerHello` and produces a secret that
is merely different, surfacing at `Finished` as `decrypt_error`. Every derivation is checked
byte-exact against RFC 8448's five traces; `TLS_AES_256_GCM_SHA384` has no published bytes and is
proven only against the local server in `interop.test.ts`.

## Handshake

### Extension responses are checked twice

RFC 9846 §4.3: an extension we never offered is `unsupported_extension`; one we offered, in a
message where it is not defined, is `illegal_parameter`. Extension bodies are parsed only in the
message that defines them, because parsing a ClientHello-shaped `key_share` out of an
EncryptedExtensions produced `decode_error` and hid the real fault. HelloRetryRequest has its own
column in Table 1: reusing the ServerHello list let a retry carrying `pre_shared_key` pass
unnoticed once this client offered a PSK.

### The offered lists are copied, and the caller's list binds acceptance

`supportedGroups` and `signatureSchemes` are copied because they are read again for the retried
ClientHello, which §4.2.4 requires to offer what the first did. Empty or duplicate lists throw
rather than returning a typed failure, since they are the caller's bug. What was offered on the
wire (`offeredExtensionCodes`, `offeredGroupCodes`) is read back off the sent ClientHello, because
the replay path sends RFC 8448's own ClientHello. The CertificateVerify check reads the caller's
option instead, so a policy narrower than the bytes still binds what we accept.

### The unoffered-scheme check runs before the path build

RFC 9846 §4.5.2 requires a CertificateVerify scheme the client offered. It is checked on the
message rather than left to `importLeafKey`, which can only say "we cannot verify this", not "we
declined this". BoringSSL validates the chain a flight earlier, on the Certificate message, so a
flight that is both unoffered-scheme and untrusted reports `illegal_parameter` here where
BoringSSL reports the certificate. No BoGo test pairs the two faults.

### The pin is learned after CertificateVerify, from the validated path

Until the signature verifies the peer has only sent a chain, which is public and replayable. An
on-path attacker replaying a host's previous certificate would teach a validate-time pin a stale
key and spend the one alarm the mechanism has. `peerPublicKeyPin` is therefore on
`HandshakeResult` only, taken from `ValidatedPath` (the copy `pinnedValidator` compares), and is
`null` on a resumption with `reverifyOnResume` off, the one configuration that validated no chain.

### Consecutive-record ceilings are BoringSSL's

TLS 1.3 sets no limit on empty records (§5.4), `user_canceled` warnings (§6.1) or `KeyUpdate`s.
The numbers (32, 4, 32) are BoringSSL's, which BoGo pins from both sides. They count consecutive
occurrences and reset when application data is delivered, BoringSSL's own rule
(`ssl/tls_record.cc`, `ssl/ssl_lib.cc`); counted over a connection's lifetime they would kill an
ordinary IMAP session on its 33rd rekey. `NewSessionTicket` gets the same shape of ceiling (32)
because each costs an HKDF expansion and a call into the caller's store.

### A requested KeyUpdate is answered once, on the next write

§4.7.3 requires the response and sets no deadline. Answering each request turns one record into
an unbounded reply stream, and a peer strict about unsolicited KeyUpdates drops the connection on
the second. Owing it to the write path also keeps every client-write key mutation inside the
write queue: sealing outside it is how one AES-GCM (key, nonce) came to cover two plaintexts.

### The compatibility ChangeCipherSpec precedes whichever flight is second

RFC 9846 D.4 puts it immediately before the second flight, which is a retried ClientHello, the
Finished flight, or a fatal alert when the handshake ends early. Sending it only before Finished
left aborted and retried handshakes without it; sixteen BoGo tests failed reading the protected
alert as a malformed ChangeCipherSpec.

### The stored chain is re-checked after the server's Finished

`reverifyOnResume` defaults to `true` because a check that must be asked for is forgotten
(BoringSSL defaults the other way; the BoGo shim passes `false`). It runs after the server's
Finished so the flight is proven to come from the PSK holder before a path build is spent;
BoringSSL runs it between EncryptedExtensions and Finished. Failure is a refused connection
carrying `chain: 'session-stored'`, because a stale stored chain (evict and reconnect) and a
refused peer-sent chain (retrying earns a second refusal) need opposite responses.

### Buffered handshake bytes across a key change are refused

RFC 9846 §5.1: a handshake message may not span a key change. Bytes left in the buffer at
ServerHello, at a HelloRetryRequest, or after Finished would be spliced onto the next flight.

### Close is per direction

RFC 9846 §6.1: `close_notify` ends the sender's writes only. One flag for both directions made
the peer's goodbye close our write side, so `close()` returned without sending ours and a peer
waiting for it waited until its timeout.

### A peer-sized input is a typed failure; a caller-sized input may throw

A ticket comes back as the PSK identity and a HelloRetryRequest cookie comes back echoed, and
either at its legal maximum overruns one record or the uint16 extension block. ClientHellos are
fragmented (§5.1 allows it), tickets are bounded where they are stored (`MAX_TICKET_BYTES`,
16 KiB) and echoed cookies at `MAX_ECHOED_COOKIE_BYTES`, so a server cannot poison the next
connection before a byte goes out. Handshake message bodies are capped at 64 KB because BoGo's
`LargeMessage` sends a 23 KB chain and 16 KB was too small.

## Sessions

### The authentication ceiling is inherited through renewals

RFC 9846 §4.7.1 notes that renewed tickets can indefinitely extend keying material derived from
one certificate check and recommends a limit. `authenticatedAt`, `peerSignatureScheme` and
`peerCertificateChain` are carried forward unchanged, and `MAX_AUTHENTICATION_AGE_SECONDS` is a
week because v1 checks no revocation and public mail leaves rotate every 60-90 days. The ceiling
is also applied on the way in (`sessionFromTicket`), since a long `IDLE` connection renews past
it. No peer this package can drive mints a ticket on a resumed connection (OpenSSL issues none
there, BoGo runs `-resume-count 1`, RFC 8448 §4 publishes none), so `session.test.ts` replays §4
and seals §3's ticket under §4's published server application key to observe the inheritance.

### A session is bound to the identity the issuing connection proved

A resumed handshake sends no Certificate, so `expectedPeerName` travels with the session and must
match exactly (an unset and a `null` policy are different answers). Host names are compared with
x509's `asciiLower`, not `toLowerCase`, because KELVIN SIGN folds to `k` under Unicode and would
widen a security comparison. Each session is offered once (App. C.4: reuse lets observers
correlate connections); the store is the caller's, so the eviction is too.

### A revived session is checked before a byte goes out

JSON turns a scheme into an arbitrary string and a `Uint8Array` into `{"0":48,...}`.
`assertUsableSession` runs from `startTls` unconditionally and throws, because a broken store is
the caller's bug. Two reviews found the check a flight too late: a dropped chain reached
`validatePath` as a raw `TypeError`, a revived one was refused as `malformed-certificate`
blaming the mail host, and with `reverifyOnResume: false` the throw landed after the handshake
completed.

## Alerts

### Distrusted CA and pin mismatch map to existing alerts

`certificate-authority-distrusted` is `unknown_ca` (§6.2: a CA that cannot be matched with a
known trust anchor, for this chain). `rejected-by-policy` is `certificate_unknown` (§6.2's
unspecified issue); a pin mismatch validates a chain perfectly, and `unknown_ca` would send a
user to their CA over a rotated key. An unknown alert description is reported with its code
rather than answered (§6: unknown alert types are error alerts), because "the server sent alert
30" is a diagnosis where "we sent illegal_parameter" is not.

## Harness

### The BoGo shim never runs `YOZZ_VALIDATOR`

BoGo's certificate factory builds leaves with an empty subject and a non-critical SAN, which
RFC 5280 §4.2.1.6 forbids, so the validator refuses every certificate the runner offers. Path
validation is x509-limbo's gate; BoGo is the state machine's. Soft fail is modelled in the shim,
not the client, which must never continue past a refused certificate. Sockets close with
`endGracefully` rather than `destroy()`: unread bytes in the receive buffer turn a close into a
RST, which fails the peer's next write, and `AppDataBeforeTLS13KeyChange` failed on a two-vCPU
runner for exactly that. The shim does not wait for the peer to close back, since BoGo's runner
waits for the shim to exit first.

### Live hosts must greet, not merely handshake

M8 is handshake and greeting. Only the greeting proves application data decrypts under the
negotiated keys in the direction we never wrote in, and `* BYE` decrypts perfectly while meaning
the server turned us away (RFC 9051 §7.1.1). The browser harness runs the same nine hosts
serially across three engines and fails the run when engines derive different pins for one host.

### The BoGo gate runs a committed manifest, strictly

`-allow-unimplemented` can skip every test and still report green, so the gate demands a pass
from every name in `manifest.txt` and reports each skip inside it as debt, by the missing thing
(a curve, a flag) with the tests it costs. The inventory run builds the manifest from what the
sweep observed, so a runner that stops early (a broken stdout pipe once took it from 432 tests to
207, unnoticed until read by hand) would silently shrink the denominator; `BORINGSSL_TEST_COUNT`
is checked against the sweep first. `baseline.txt` records what each in-scope test does today,
the same shape as x509-limbo's `expected-disagreements.txt`, because a milestone that is red for
weeks is a check everyone scrolls past. The comparison walks the manifest, so the two files must
name the same tests or a deleted line goes unchecked. The previous results file is deleted before
each run: `.bogo/` is cached whole in CI and the runner exits non-zero for ordinary failures, so a
crashed runner would otherwise re-read the last run and report nothing moved.

### An undefined `-verify-prefs` scheme is dropped, not declined

RFC 9846 §4.3.3 and §4.5.2 leave RSA-PKCS1 and SHA-1 out of CertificateVerify, so the flag names
a value `signatureSchemes` can never hold. BoGo agrees: the six tests passing one set `shouldFail`
at TLS 1.3 and sign anyway under `IgnorePeerSignatureAlgorithmPreferences`, owing the client
`illegal_parameter`. Declining skipped them; dropping measures the unimplemented-scheme arm of the
§4.5.2 check (the unoffered-but-implementable arm is what `VerifyPreferences-Enforced` catches).
An empty result offers the default six.
