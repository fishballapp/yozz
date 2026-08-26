# M0 — subtls, read end to end

> Study notes for writing our own client, per
> [DECISIONS.md](../../../DECISIONS.md#we-write-the-tls-client-ourselves-subtls-is-reference-not-dependency):
> read it with the file open beside us, start from a blank file, never fork.
> Produced 2026-08-18. **Reference only — subtls is not a dependency.**

## The key schedule

Source snapshot: `jawj/subtls` commit `6e7949a55c1715df2c8f2b04286e19c2a3e8bec8`.

- `startTls()` generates an extractable P-256 ECDH key pair with `SubtleCrypto.generateKey()`, exports the public point, and sends it in `ClientHello` (`src/tls/startTls.ts:41-60`).
- `getHandshakeKeys()` imports the server point and obtains the 256-bit ECDHE shared secret with `importKey()` and `deriveBits()` (`src/tls/keys.ts:7-13`).
- Its HKDF ladder is:

  1. `earlySecret = HKDF-Extract(0, zero HashLen bytes)`.
  2. `derivedSecret = Derive-Secret(earlySecret, "derived", Hash(""))`.
  3. `handshakeSecret = HKDF-Extract(derivedSecret, ECDHE)`.
  4. `clientSecret/serverSecret = Derive-Secret(handshakeSecret, "c hs traffic"/"s hs traffic", Hash(ClientHello…ServerHello))`.
  5. Each traffic secret produces `"key"` and `"iv"` values (`src/tls/keys.ts:20-49`).

  The salt is represented as one zero byte rather than HashLen zero bytes; those are equivalent after HMAC key padding.

- `getApplicationKeys()` continues:

  1. `derivedSecret = Derive-Secret(handshakeSecret, "derived", Hash(""))`.
  2. `masterSecret = HKDF-Extract(derivedSecret, zero HashLen bytes)`.
  3. `clientSecret/serverSecret = Derive-Secret(masterSecret, "c ap traffic"/"s ap traffic", transcript-through-server-Finished)`.
  4. Each application traffic secret produces `"key"` and `"iv"` (`src/tls/keys.ts:54-86`).

- The Finished key is `HKDF-Expand-Label(handshakeTrafficSecret, "finished", "", HashLen)`. Finished verify data is HMAC over the transcript hash (`src/tls/parseEncryptedHandshake.ts:205-223`, `src/tls/startTls.ts:137-153`).
- WebCrypto performs ECDH, SHA-256, HMAC, AES-GCM, ECDSA, and RSA verification. `cryptoProxy` forwards these to `crypto.subtle` in browsers (`src/util/cryptoProxy.ts:1-12`).
- HKDF itself is hand-written: `hkdfExtract()` implements Extract with WebCrypto HMAC; `hkdfExpand()` loops HMAC blocks; `hkdfExpandLabel()` serializes TLS 1.3’s `HkdfLabel` (`src/tls/hkdf.ts:6-112`). It does not use WebCrypto’s `"HKDF"` algorithm.
- AES-GCM keys are imported with `importKey()`; `Crypter.processUnsequenced()` invokes `subtle.encrypt()` or `subtle.decrypt()` through `cs[this.mode]` (`src/tls/aesgcm.ts:25-44`).

## The record layer

- Plaintext records use the five-byte header `type || legacy_record_version || uint16 length`. `readTlsRecord()` reads and validates it, enforces a 16 KiB plaintext limit, and returns the payload plus the exact header bytes used as AEAD additional data (`src/tls/tlsRecord.ts:23-67`).
- Encrypted output is `TLSInnerPlaintext = content || inner_content_type`; no padding is generated. The outer type is always `application_data`, the version is `0x0303`, and AES-GCM’s 16-byte tag is included in the outer length (`makeEncryptedTlsRecord()`, `src/tls/tlsRecord.ts:125-150`).
- `makeEncryptedTlsRecords()` fragments plaintext into at most 16 KiB per record (`src/tls/tlsRecord.ts:152-160`).
- `readEncryptedTlsRecord()` authenticates the five-byte outer header, decrypts ciphertext plus tag, scans backward over zero padding, removes the inner type byte, and returns the content (`src/tls/tlsRecord.ts:79-114`).
- Wire reads may end anywhere. `ReadQueue.dequeue()` waits until the requested byte count is present and combines or splits relay/WebSocket chunks as needed (`src/util/readQueue.ts:31-101`). `Bytes.ensureReadAvailable()` grows its buffer and fetches missing input (`src/util/bytes.ts:67-88`).
- A handshake message may itself span TLS records. `bytesFromTlsRecords()` and `bytesFromEncryptedTlsRecords()` put record payloads behind `LazyReadFunctionReadQueue`, presenting one continuous `ASN1Bytes` stream to the handshake parser (`src/tls/tlsRecord.ts:70-77`, `src/tls/tlsRecord.ts:116-123`; `src/util/readQueue.ts:141-166`).
- Application `read()` returns one decrypted record’s content. Higher protocols requiring exact byte counts must add their own `LazyReadFunctionReadQueue`, as `postgres()` does (`src/postgres.ts:74-75`).
- Each `Crypter` owns a `recordsProcessed` counter. For record number `n`, it copies the static IV and XORs `n` into its least-significant, right-aligned bytes before AES-GCM (`src/tls/aesgcm.ts:3-42`).
- Separate `Crypter` instances give each direction and epoch an independent sequence starting at zero. Handshake instances are created after `ServerHello`; application instances are created after verifying the server Finished (`src/tls/startTls.ts:84-94`, `src/tls/startTls.ts:169-176`). No later key change exists.

## The transcript hash

- There is no incremental hash object. The implementation retains encoded handshake bytes, concatenates the required prefix, and calls `subtle.digest("SHA-256", …)` at each checkpoint.
- `hellos` is the complete ClientHello and ServerHello handshake messages, excluding TLS record headers. Dummy ChangeCipherSpec records are also excluded (`src/tls/startTls.ts:87-90`).
- Server CertificateVerify hashes `hellos || EncryptedExtensions || [CertificateRequest] || Certificate`, then constructs `64 spaces || "TLS 1.3, server CertificateVerify" || 0x00 || transcript_hash` (`src/tls/parseEncryptedHandshake.ts:159-175`).
- Server Finished hashes the transcript through CertificateVerify (`src/tls/parseEncryptedHandshake.ts:205-223`).
- Client Finished hashes through server Finished, plus the empty client Certificate message if one was requested (`src/tls/startTls.ts:120-158`).
- Application traffic secrets use the transcript through server Finished. If an empty client Certificate was produced, the code deliberately recomputes a shorter hash that excludes it (`src/tls/startTls.ts:160-172`).
- HelloRetryRequest is detected by its fixed random and immediately rejected with `Unexpected HelloRetryRequest`. There is no synthetic `message_hash`, second ClientHello, cookie handling, or rewritten transcript (`src/tls/parseServerHello.ts:13-22`).

## Certificate handling

- TLS Certificate entries are parsed in `parseEncryptedHandshake()`. Each DER certificate is passed to `Cert.create()`; per-entry TLS extensions are skipped (`src/tls/parseEncryptedHandshake.ts:134-154`).
- DER decoding is custom. Primitive ASN.1 lengths, OIDs, times, bit strings, sequences, and octet strings live in `ASN1Bytes` (`src/util/asn1bytes.ts:5-141`). X.509-specific OIDs, distinguished names, GeneralNames, and algorithm mappings live in `src/tls/certUtils.ts`.
- `Cert.create()` records the exact TBSCertificate slice as `signedData`, the SPKI slice as `publicKey.all`, and the complete certificate as `rawData` (`src/tls/cert.ts:94-184`, `src/tls/cert.ts:412-432`).
- It decodes DNS SANs, key usage, extended key usage, authority/subject key identifiers, and basic constraints (`src/tls/cert.ts:188-324`).
- Server CertificateVerify is checked using the leaf SPKI before path validation. Supported schemes are ECDSA-P256-SHA256 and RSA-PSS-RSAE-SHA256 (`src/tls/parseEncryptedHandshake.ts:166-200`).
- `verifyCerts()` does not construct arbitrary paths. For each presented certificate, it first looks for a root indexed by authority key ID—or issuer DN if no key ID exists—then falls back to the next certificate in the presented list (`src/tls/verifyCerts.ts:46-76`). `TrustedCert.databaseFromPEM()` builds the subject/SKI index (`src/tls/cert.ts:548-579`).
- For each signer it checks current validity, key usage, CA basic constraints, path length, and the subject certificate’s signature. Supported chain signatures are ECDSA SHA-256/384 and RSA PKCS#1 v1.5 SHA-256/384 (`src/tls/verifyCerts.ts:78-129`).
- Hostname validation uses only DNS `subjectAltName`. `subjectAltNameMatchingHost()` performs exact matching or a one-label leftmost wildcard match (`src/tls/cert.ts:465-479`). It does not use Common Name.

## What it does that we should copy

- Copy the separation between transport chunking and TLS record chunking: `ReadQueue` for exact relay reads, then `LazyReadFunctionReadQueue` for handshake messages spanning records (`src/util/readQueue.ts:21-101`, `src/util/readQueue.ts:141-166`).
- Copy `Bytes._writeLengthGeneric()` and `expectLength()`: reserve a length field, fill it after writing, and assert the parser consumed exactly the declared region (`src/util/bytes.ts:100-110`, `src/util/bytes.ts:352-418`).
- Copy the record nonce construction and use the exact encoded outer header as AES-GCM additional data (`Crypter.processUnsequenced()`, `src/tls/aesgcm.ts:25-42`; `makeEncryptedTlsRecord()`, `src/tls/tlsRecord.ts:125-146`).
- Copy backward removal of TLSInnerPlaintext padding before reading the inner content type (`readEncryptedTlsRecord()`, `src/tls/tlsRecord.ts:90-96`).
- Copy transcript capture from the exact serialized handshake messages, excluding record headers and compatibility CCS (`startTls()`, `src/tls/startTls.ts:87-90`, `src/tls/startTls.ts:137-172`).
- Copy the CertificateVerify input construction exactly: 64 spaces, context string, zero separator, transcript hash (`parseEncryptedHandshake()`, `src/tls/parseEncryptedHandshake.ts:159-175`).
- Copy the application-secret transcript boundary: through server Finished, not through the client Certificate or client Finished (`src/tls/startTls.ts:160-172`).
- Copy `ecdsaVerify()`’s conversion of DER `(r,s)` integers into WebCrypto’s fixed-width P1363 representation, including removal of sign-padding and left-padding short integers (`src/tls/ecdsa.ts:7-43`).
- Copy the extraction of exact TBSCertificate and SPKI byte slices rather than reconstructing their DER before verification (`Cert.create()`, `src/tls/cert.ts:99-184`, `src/tls/cert.ts:414-432`).
- Copy distinct encryption/decryption objects for handshake and application epochs so sequence numbers reset when keys change (`src/tls/startTls.ts:84-94`, `src/tls/startTls.ts:169-176`).

## Where it is non-compliant or incomplete

- Only TLS 1.3 with `TLS_AES_128_GCM_SHA256`, P-256 ECDHE, and two SHA-256 CertificateVerify schemes is offered (`src/tls/makeClientHello.ts:24-26`, `src/tls/makeClientHello.ts:67-79`, `src/tls/makeClientHello.ts:82-104`).
- HelloRetryRequest is rejected outright, including a valid cookie-only retry (`src/tls/parseServerHello.ts:13-22`).
- PSK, resumption, and 0-RTT are absent. NewSessionTicket is parsed only for display and discarded (`src/tls/sessionTicket.ts:6-35`; `src/tls/tlsRecord.ts:106-109`).
- KeyUpdate is absent. `getApplicationKeys()` discards the application traffic secrets and returns only keys/IVs, so it cannot derive `"traffic upd"` secrets (`src/tls/keys.ts:54-86`). There is no record-count or AEAD usage limit before nonce exhaustion (`src/tls/aesgcm.ts:27-38`).
- The nominal SHA-384 support in `getHandshakeKeys()` is broken: `hellosHash` is always SHA-256 even when `hashBits` is 384 (`src/tls/keys.ts:7-18`). The actual handshake also hardcodes SHA-256 and 128-bit AES throughout (`src/tls/startTls.ts:90`, `src/tls/parseEncryptedHandshake.ts:162-164`, `src/tls/parseEncryptedHandshake.ts:208-211`).
- `hkdfExpand()` does not enforce RFC 5869’s `N <= 255`, and `hkdfExpandLabel()` does not validate its one-byte label/context or two-byte output lengths before truncating them into fields (`src/tls/hkdf.ts:70-85`, `src/tls/hkdf.ts:105-110`).
- `startTls()` requires exactly one server compatibility ChangeCipherSpec at one fixed point. TLS 1.3 implementations must tolerate permitted compatibility CCS records, and a server is not required to send this exact one (`src/tls/startTls.ts:73-82`). CCS records elsewhere are rejected by strict expected-type reads.
- Encrypted alerts are mishandled. Only exact warning-level `close_notify` becomes EOF; other encrypted fatal or warning alerts can be returned to the caller as application bytes when no expected type was supplied (`src/tls/tlsRecord.ts:98-113`). Local protocol failures throw JavaScript errors instead of sending the appropriate fatal alert.
- Plaintext alert parsing does not require a two-byte payload. A malformed warning alert with trailing bytes is recursively skipped without consuming its remainder, desynchronizing the record stream (`src/tls/tlsRecord.ts:37-59`).
- Post-handshake handshake messages are treated per record rather than as a handshake byte stream. NewSessionTicket is recognized only when byte zero of one decrypted record is `0x04`; fragmentation or multiple coalesced post-handshake messages are not handled (`src/tls/tlsRecord.ts:98-109`).
- KeyUpdate and post-handshake CertificateRequest are therefore not processed. An unrecognized post-handshake message can surface as application content (`src/tls/tlsRecord.ts:98-113`).
- ALPN selection is not checked against the client’s offered list. `parseEncryptedHandshake()` accepts and returns any single server string (`src/tls/makeClientHello.ts:46-58`, `src/tls/parseEncryptedHandshake.ts:49-59`).
- Neither ServerHello nor EncryptedExtensions rejects duplicate extension types; both loops lack a seen-extension set (`src/tls/parseServerHello.ts:30-73`, `src/tls/parseEncryptedHandshake.ts:27-109`).
- CertificateRequest extensions are skipped wholesale, so the mandatory `signature_algorithms` extension and malformed/duplicate extensions are not validated. Client authentication is unsupported; the response is always an empty Certificate (`src/tls/parseEncryptedHandshake.ts:114-131`, `src/tls/startTls.ts:120-133`).
- Per-certificate TLS extensions are ignored (`src/tls/parseEncryptedHandshake.ts:149-151`).
- UNCERTAIN: server P-256 point validation is delegated implicitly to WebCrypto. The source leaves this as a TODO and performs no explicit on-curve/subgroup validation (`src/tls/parseServerHello.ts:47-65`).
- Concurrent `write()` calls are not serialized as complete batches. `Crypter` orders individual promise results, but a multi-record write can interleave sequence allocation with another write and later emit its records in a different wire order (`src/tls/aesgcm.ts:13-28`, `src/tls/startTls.ts:191-202`).
- ECDH private keys are generated extractable and are exported/logged in `chatty` mode. Application AES keys are also imported extractable despite an inline TODO (`src/tls/startTls.ts:41-51`, `src/tls/startTls.ts:173-176`).
- Finished verification uses the early-exit `equal()` byte loop instead of a constant-time comparison (`src/tls/parseEncryptedHandshake.ts:222-223`; `src/util/array.ts:14-18`).
- Hostname comparison is case-sensitive despite DNS case-insensitivity. It does not normalize IDNs or trailing dots and cannot validate IP-address SANs because only `dNSName` entries are retained (`src/tls/cert.ts:198-204`, `src/tls/cert.ts:465-479`).
- Unknown certificate extensions—including unknown critical extensions—are ignored. The source explicitly calls out missing Name Constraints, CRL Distribution Points, and criticality checking (`src/tls/cert.ts:389-404`).
- Path validation does not enforce issuer-DN/subject-DN chaining, authority-key-ID/subject-key-ID consistency between presented intermediates, CA extended-key-usage constraints, certificate policies, revocation, or self-issued path-length rules. It simply tries the next presented certificate and verifies the signature (`src/tls/verifyCerts.ts:50-129`).
- Key usage is checked on the wrong certificates. Signing CAs are required to have `digitalSignature`, while certificate signing requires `keyCertSign`; the leaf’s `digitalSignature` usage is never checked for CertificateVerify (`src/tls/verifyCerts.ts:29-41`, `src/tls/verifyCerts.ts:82-90`).
- A missing leaf Extended Key Usage is rejected by default, although absence of EKU does not itself prohibit server authentication. Only the exact serverAuth OID is accepted (`src/tls/verifyCerts.ts:38-41`).
- DER parsing assumes an explicit v3 marker and mandatory extensions, so valid v1/v2 certificates and v3 certificates without extensions cannot be parsed (`src/tls/cert.ts:94-105`, `src/tls/cert.ts:188-191`).
- Critical booleans are handled only for KeyUsage and BasicConstraints. A critical SAN or ExtendedKeyUsage places a BOOLEAN where those handlers expect the OCTET STRING and fails parsing (`src/tls/cert.ts:198-206`, `src/tls/cert.ts:226-237`).
- Distinguished-name parsing supports only four string types and only one AttributeTypeAndValue per SET (`src/tls/certUtils.ts:102-140`). ASN.1 OID parsing assumes the combined first two arcs occupy one byte, which is not general DER OID decoding (`src/util/asn1bytes.ts:32-49`).
- Certificate signature verification supports only ECDSA SHA-256/384 and RSA PKCS#1 v1.5 SHA-256/384. RSA-PSS-signed certificates, EdDSA, SHA-512 chains, and other valid Web PKI algorithms fail (`src/tls/verifyCerts.ts:106-124`). AlgorithmIdentifier parameters other than NULL are also not parsed (`src/tls/cert.ts:114-121`, `src/tls/cert.ts:417-425`).
- No exporter master secret or resumption master secret is derived; only handshake and initial application traffic material exists (`src/tls/keys.ts:7-86`).
