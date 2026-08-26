# RFC 8448's traces, as vectors

[`rfc8448.txt`](rfc8448.txt) is *Example Handshake Traces for TLS 1.3*, committed
verbatim. [`rfc8448.ts`](rfc8448.ts) parses it; nothing is transcribed by hand,
because a mis-copied vector is a test that passes against the wrong answer.

| | |
| --- | --- |
| Source | `https://www.rfc-editor.org/rfc/rfc8448.txt` |
| SHA-256 | `6564d1376d1ec744fc7a9993da15ebc1b9be361908b166091f47ef605c537fba` |

An RFC is immutable, so there is nothing to re-fetch and no pin to bump. Verify
the copy with `shasum -a 256 vectors/rfc8448.txt` if you ever doubt it.

## What the parser reads

Sections 3–7, the five traces, as `{client}`/`{server}` steps carrying labelled
hex fields. Each field's declared `(N octets)` is checked against what was
actually read — that check is what catches a hex run truncated at a page break,
which would otherwise yield a shorter vector that still looks like a vector.

Two prose stand-ins are read as bytes: `(empty)` and the Early Secret's
`0 (all zero octets)`, both as zero length. RFC 5869 §2.2 makes an absent HKDF
salt HashLen zeros, so `hkdfExtract` applies that rule itself.

## What each trace is used for

| | Used for |
| --- | --- |
| **§3** Simple 1-RTT | The whole client, replayed against a scripted peer: hello, the coalesced server flight, both Finisheds, an application write, `close_notify` |
| **§5** HelloRetryRequest | The `message_hash` transcript rule of RFC 9846 §4.1, and a P-256 key share in ClientHello2 |
| **§6** Client Authentication | `CertificateRequest`, and the client declining with an empty `Certificate` |
| **§7** Compatibility Mode | A 32-byte `legacy_session_id`, ChangeCipherSpec ignored on receipt and emitted on send |
| **§4** Resumed 0-RTT | Resumption end to end, in [`src/session.test.ts`](../src/session.test.ts): §3's `NewSessionTicket` expands to exactly the pre-shared key §4 consumes, the binder we compute is §4's, and the ClientHello we build IS its 512-octet record. The 0-RTT half — early data and `EndOfEarlyData` — stays deliberately unbuilt, so §4 is still never replayed as a client |

The 41 `payload` and `complete record` pairs feed the record layer both ways: seal
a payload into the published record, open a published record back into its
payload. Every published handshake message feeds the codec.

Section 2's RSA private key is still unused. We verify signatures; we never sign.

**§4 publishes the ClientHello twice and the two are not the same message.** The
`construct a ClientHello` step prints 477 octets — the message as it stands before
its binder exists, which is what §4.3.11.2 calls the truncated ClientHello — and
the `send handshake record` step below it prints the 512 that went on the wire.
Hashing the first is 35 octets short, and for as long as resumption was unbuilt
that was why §4's running transcript did not reproduce.

## What RFC 8448 cannot cover

It is a SHA-256, AES-128-GCM, X25519 document with one P-256 HelloRetryRequest.
`TLS_AES_256_GCM_SHA384` and P-384, the pair `posteo.de` requires, have no
published bytes anywhere in it. Those are proven in
[`src/interop.test.ts`](../src/interop.test.ts) against a real TLS 1.3 server
instead.
