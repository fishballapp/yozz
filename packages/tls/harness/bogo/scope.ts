/**
 * BoGo tests declared out of scope, as rules over what the runner tells us about each test;
 * `manifest.txt` is what survives them. A version token in a name is trustworthy because
 * `checkTests` (`ssl/test/runner/runner.go`) panics when the name and config disagree; the side
 * and protocol arrive in the `-write-settings` path.
 */

export type InventoryRow = {
  readonly name: string;
  readonly protocol: 'tls' | 'dtls' | 'quic';
  readonly side: 'client' | 'server';
  /** Presence only; a repeated flag appears once per occurrence. Values are in `argv`. */
  readonly flags: readonly string[];
  /**
   * Whole argv, because `-curves` and `-verify-prefs` name the algorithm in the next token. Rules
   * read argv rather than the shim's decline reason, which names only the first refused flag.
   */
  readonly argv: readonly string[];
  /**
   * Measured in the inventory run, in two forms: the runner's own error when the test fails, and
   * the client's `alert-received protocol_version` when a TLS 1.2 test passes by accident.
   */
  readonly peerRefusedVersion: boolean;
};

export type ScopeRule = {
  readonly id: string;
  readonly why: string;
  readonly excludes: (row: InventoryRow) => boolean;
};

const hasAny = (flags: readonly string[], names: readonly string[]): boolean =>
  names.some(name => flags.includes(name));

/** Every value given to `flag`, one string per occurrence. */
const valuesOf = (argv: readonly string[], flag: string): readonly string[] =>
  argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ''] : []));

/** True when the test asks the client to offer any of `ids` as a named group. */
const offersGroup = (row: InventoryRow, ids: Readonly<Record<number, string>>): boolean =>
  valuesOf(row.argv, '-curves').some(value => ids[Number(value)] !== undefined);

/** The same over `-verify-prefs`: a signature scheme the test asks us to accept. */
const offersScheme = (row: InventoryRow, ids: Readonly<Record<number, string>>): boolean =>
  valuesOf(row.argv, '-verify-prefs').some(value => ids[Number(value)] !== undefined);

const VERSION_TOKEN = /(^|-)(SSL3|TLS1|TLS11|TLS12)(-|$)/;

/** Post-quantum key exchange and signatures, out of v1 together. */
const POST_QUANTUM_GROUPS: Readonly<Record<number, string>> = {
  514: 'MLKEM1024',
  4588: 'X25519MLKEM768',
};

const POST_QUANTUM_SCHEMES: Readonly<Record<number, string>> = {
  2308: 'ML-DSA-44',
  2309: 'ML-DSA-65',
  2310: 'ML-DSA-87',
};

/** P-521, in its two shapes: the ECDHE group and the ECDSA scheme over it. */
const P521_GROUP: Readonly<Record<number, string>> = { 25: 'P-521' };
const P521_SCHEME: Readonly<Record<number, string>> = { 1539: 'ECDSA_P521_SHA512' };

/**
 * Not CertificateVerify schemes: RFC 9846 §4.3.3 (RSA-PKCS1 "not defined for use in signed TLS
 * handshake messages") and §4.5.2 ("SHA-1 ... MUST NOT be used in any signatures of
 * CertificateVerify messages").
 */
export const LEGACY_SCHEMES: Readonly<Record<number, string>> = {
  513: 'RSA_PKCS1_SHA1',
  515: 'ECDSA_SHA1',
  1025: 'RSA_PKCS1_SHA256',
  1056: 'RSA_PKCS1_SHA256_LEGACY',
  1281: 'RSA_PKCS1_SHA384',
  1537: 'RSA_PKCS1_SHA512',
};

/**
 * Named so the backlog reads "we do not have P-521" rather than "we do not parse `-curves`".
 * The shim declines by these names and the rules exclude by the same ids.
 */
export const UNIMPLEMENTED_CURVES: Readonly<Record<number, string>> = {
  ...P521_GROUP,
  ...POST_QUANTUM_GROUPS,
};

/** The same, for signature schemes a `-verify-prefs` value asks us to verify. */
export const UNIMPLEMENTED_SCHEMES: Readonly<Record<number, string>> = {
  ...P521_SCHEME,
  ...POST_QUANTUM_SCHEMES,
};

/** Tests where RFC 9846 and BoringSSL disagree. Every entry quotes the sentence it rests on. */
export const RFC_DIVERGENCES: readonly { readonly test: string; readonly rfc: string }[] = [
  {
    test: 'TLS13-InvalidCompressionMethod',
    rfc: '§4.2.3: "A single byte which MUST have the value 0. If a TLS 1.3 ServerHello is received with any other value in this field, the client MUST abort the handshake with an illegal_parameter alert." BoringSSL raises :DECODE_ERROR:.',
  },
  {
    test: 'TLS13-HRR-InvalidCompressionMethod',
    rfc: '§4.2.4 checks legacy_compression_method "as specified in Section 4.2.3", so the retry inherits §4.2.3 and its illegal_parameter.',
  },
  {
    test: 'TLS13-OnlyPadding-TLS',
    rfc: '§5.4: "If a receiving implementation does not find a non-zero octet in the cleartext, it MUST terminate the connection with an unexpected_message alert." BoringSSL calls it a decryption failure.',
  },
  {
    test: 'KeyUpdate-InvalidRequestMode',
    rfc: '§4.7.3 on request_update: "If an implementation receives any other value, it MUST terminate the connection with an illegal_parameter alert." BoringSSL raises :DECODE_ERROR:.',
  },
  {
    test: 'GarbageCertificate-Client-TLS13',
    rfc: '§6.2: "bad_certificate: A certificate was corrupt, contained signatures that did not verify correctly, etc." A certificate that will not parse is corrupt. BoringSSL sends decode_error.',
  },
  {
    test: 'SendWarningAlerts-TLS13',
    rfc: '§6: "All the alerts listed in Section 6.2 MUST be sent with AlertLevel=fatal and MUST be treated as error alerts when received regardless of the AlertLevel in the message." A warning-level unexpected_message is therefore the peer\'s error alert, and the connection ends without a reply. BoringSSL answers with decode_error.',
  },
  {
    test: 'EncryptedExtensionsWithKeyShare-TLS13',
    rfc: '§4.3: "If an implementation receives an extension which it recognizes and which is not specified for the message in which it appears, it MUST abort the handshake with an illegal_parameter alert." A key_share in EncryptedExtensions is exactly that. BoringSSL sends unsupported_extension and checks it, so no mapping can bridge this one.',
  },
  {
    test: 'PointFormat-EncryptedExtensions-TLS13',
    rfc: '§4.3: an extension response to a request we never made "MUST abort the handshake with an unsupported_extension alert". We do not offer ec_point_formats. BoringSSL parses the body and raises :ERROR_PARSING_EXTENSION: instead.',
  },
  {
    test: 'HelloRetryRequestVersionMismatch-TLS13',
    rfc: '§4.2.3 on a legacy_version that is not 0x0303 — "MUST abort the handshake with a protocol_version alert" — which §4.2.4 gives the HelloRetryRequest too. BoringSSL raises :DECODE_ERROR:.',
  },
  {
    test: 'UnencryptedEncryptedExtensions',
    rfc: '§5.1: "If a TLS implementation receives an unexpected record type, it MUST terminate the connection with an unexpected_message alert." A cleartext handshake record after the ServerHello is one. BoringSSL treats anything it cannot attribute as a decryption failure.',
  },
  {
    test: 'ExtensionTrailingData-CertificateAuthorities-Client-TLS-TLS13',
    rfc: '§4.3 requires a decode_error for data left over after an extension, and then carves out the case we are in: "This does not apply if the receiver does not implement or is configured to ignore an extension." This client answers every CertificateRequest with no certificate, so certificate_authorities is not ours to parse.',
  },
  {
    test: 'RejectEmptyCertificateAuthorities-Client-TLS-TLS13',
    rfc: '§4.3 again, and the same carve-out: an extension we do not implement is one we may ignore, and an empty certificate_authorities list is only malformed to a client that reads it.',
  },
  ...['', '-ImplicitHandshake', '-PackHandshake', '-SplitHandshakeRecords'].map(variant => ({
    test: `CertificateVerificationFail-Client-TLS13-TLS-Sync${variant}`,
    rfc: '§4.5.1: a receiver that "cannot construct an acceptable chain using the provided certificates and decides to abort the handshake... MUST abort the handshake with an appropriate certificate-related alert". We send `certificate_unknown`, which §6.2 defines as "some other (unspecified) issue arose in processing the certificate, rendering it unacceptable" — an application refusing on its own policy is exactly that. BoringSSL sends `handshake_failure`, which is not certificate-related at all, and checks for it. Note this is the LEGACY callback only: with `-use-custom-verify-callback` BoringSSL wants `certificate_unknown` too (`verifyFailLocalError` in `state_machine_tests.go`), and those tests pass. Its four Async siblings do not check the alert and pass.',
  })),
  ...['NoContext', 'EmptyContext'].map(variant => ({
    test: `ExportKeyingMaterial-${variant}-TLS-TLS13`,
    rfc: '§7.1 declares the exporter label\'s home field `opaque label<7..255> = "tls13 " + Label`, and the prefix alone is SIX octets — so an empty `Label` cannot be encoded, and `hkdfLabel` refuses to derive a key from a struct that could not go on a wire. These two tests pass `-export-label ""`, and BoringSSL computes the exporter over the 6-octet label anyway. Their two labelled siblings, `ExportKeyingMaterial-TLS-TLS13` and `-Small-`, PASS — including 1024 octets, which is the only thing in the suite that reaches `hkdfExpand`\'s multi-block loop, so the exporter itself is proven against the runner\'s own computation byte for byte.',
  })),
  {
    test: 'DuplicateExtensionClient-TLS-TLS13',
    rfc: '§4.3 forbids a repeated extension and names no alert for it. We say illegal_parameter everywhere; BoGo wants decode_error here and illegal_parameter for the same fault in a NewSessionTicket, so there is no single answer to match.',
  },
];

export const SCOPE_RULES: readonly ScopeRule[] = [
  {
    id: 'not-tls',
    why: 'DTLS and QUIC are different record layers. YOZZ speaks TLS over a stream socket and will not grow either.',
    excludes: row => row.protocol !== 'tls',
  },
  {
    id: 'server',
    why: 'The package is a client. There is no server to test.',
    excludes: row => row.side !== 'client',
  },
  {
    id: 'pre-tls13-by-name',
    why: 'The test names its version, and the runner panics if a versioned name disagrees with its config. TLS 1.3 is the whole of what this client speaks.',
    excludes: row => VERSION_TOKEN.test(row.name),
  },
  {
    id: 'pre-tls13-by-peer',
    why: 'The name says nothing about versions, but the runner refused the handshake because our ClientHello offered only TLS 1.3. Its server is older, so the test is not ours.',
    excludes: row => row.peerRefusedVersion,
  },
  {
    id: 'client-auth',
    why: 'A mail client authenticates with a password over an authenticated channel, never with a certificate. Post-handshake auth goes with it.',
    excludes: row =>
      hasAny(row.flags, [
        '-cert-file',
        '-key-file',
        '-require-any-client-certificate',
        '-use-old-client-cert-callback',
        '-available-client-cert-types',
        '-accepted-peer-cert-types',
        '-expect-certificate-types',
        '-expect-client-ca-list',
        // A client-auth flag in effect: both `FailCertCallback-Client-*` tests set
        // `ClientAuth: RequestClientCert` (`basic_tests.go`), which is runner config, not argv.
        '-fail-cert-callback',
      ]),
  },
  {
    id: 'early-data',
    why: 'ROADMAP names 0-RTT as deliberately never implemented: replayable application data is a security property we decline rather than a feature we lack.',
    excludes: row =>
      row.flags.some(flag => flag.includes('early-data')) ||
      row.flags.includes('-expect-ticket-supports-early-data'),
  },
  {
    id: 'renegotiation',
    why: 'Renegotiation does not exist in TLS 1.3, and the flags that surround it are all TLS 1.2 machinery.',
    excludes: row =>
      row.flags.some(flag => flag.includes('renegotiat')) ||
      hasAny(row.flags, ['-no-legacy-server-connect', '-expect-secure-renegotiation']),
  },
  {
    id: 'alpn',
    why: "ROADMAP names ALPN as deliberately never implemented. IMAP and SMTP are negotiated by port, not by protocol name, and ALPS rides on ALPN. NPN goes with it: it is what ALPN replaced, and this client never sends the extension. Its two client-side shapes are excluded for different reasons and the difference matters. BoGo's NPN *negotiation* tests run at `MaxVersion: VersionTLS12` (`state_machine_tests.go`), so they are pre-1.3 like the rest. `NPN-Forbidden-TLS13` (`extension_tests.go`) is TLS 1.3 and stays out on the `not-our-clienthello` ground instead — `handshake_server.go` gates the NPN response on `clientHello.nextProtoNeg`, which we never set, so the unsolicited extension it exists to catch never arrives. The predicate read `-select-next-proto` by name and missed `-select-empty-next-proto`, which held eight TLS 1.2 tests in the manifest.",
    excludes: row =>
      row.flags.some(
        flag =>
          flag.includes('alpn') ||
          flag.includes('application-settings') ||
          flag.includes('next-proto') ||
          flag.includes('npn'),
      ),
  },
  {
    id: 'ech',
    why: "Encrypted ClientHello, which DECISIONS puts out of v1 on what it would buy a browser talking through OUR relay. ECH hides the SNI from a network observer; the relay reads the hostname regardless, because it is the thing that calls `connect(host, port)`. On the leg where an observer exists, browser to relay, the inner ClientHello is already inside WSS to yozz.app. On the leg where the SNI is in the clear, relay to mail host, the observer already has the destination IP and port 993. So it would hide a name from someone who can infer it and not from the one party that learns every user's provider, which is us. The cost is not small either: HPKE assembled by hand because WebCrypto has none, DNS HTTPS-record lookups for the config, and retry_configs. The predicate names the MECHANISM rather than one flag of it — all 18 `ech` flags in the runner are ECH's, checked against the flag universe, so there is no false positive to trade for the breadth.",
    excludes: row => row.flags.some(flag => flag.includes('ech')),
  },
  {
    id: 'not-our-clienthello',
    why: 'The test asks for a verdict only a client whose ClientHello differs from ours can give — either because the thing it tests never reaches us, or because it reaches us and we are entitled to answer differently. Each was measured, not guessed: the runner echoes extended_master_secret and renegotiation_info only to a client that offered them (`handshake_server.go` processClientExtensions) and this client offers neither; a server_name acknowledgement is unsolicited only for a client that sent no SNI, and ours always does; BoringSSL disables Ed25519 by default where we advertise it and verify it, which is what the three Ed25519 entries share, though not by the same mechanism: `Ed25519DefaultDisable-NoAccept` and `Client-VerifyDefault-Ed25519-TLS13` sign Ed25519 with `IgnorePeerSignatureAlgorithmPreferences` and expect the refusal a client owes a scheme it withheld, while `Ed25519DefaultDisable-NoAdvertise` sets no bug at all and expects the runner to find no common algorithm — nothing signs. All three turn on a default we do not share, and this client withheld nothing (`Client-Verify-Ed25519-TLS13`, which offers it explicitly, passes); and BoringSSL offers a post-quantum group by default where we offer X25519, P-256 and P-384.',
    excludes: row =>
      [
        'EMS-Forbidden-TLS13',
        'RenegotiationInfo-Forbidden-TLS13',
        'UnsolicitedServerNameAck-TLS-TLS13',
        'Ed25519DefaultDisable-NoAccept',
        'Ed25519DefaultDisable-NoAdvertise',
        'Client-VerifyDefault-Ed25519-TLS13',
        'PostQuantumEnabledByDefaultInClients',
        // An SSL 3.0 server that refuses our ClientHello for want of a shared suite; the
        // unsolicited ServerHello the test is named for never arrives.
        'NoSSL3-Client-Unsolicited',
        // `MaxVersion: VersionTLS12` (`cipher_suite_tests.go`), and the only test using `-cipher`,
        // which takes an OpenSSL cipher string; the shim exits 89 on it before `pre-tls13-by-peer`
        // could measure the refusal.
        'UnsupportedCipherSuite',
      ].includes(row.name),
  },
  {
    id: 'needs-path-validation',
    why: "The check is real and ours, but it lives in `YOZZ_VALIDATOR` — which cannot run against BoGo's certificates at all (see README). x509-limbo is where keyUsage is gated.",
    excludes: row =>
      [
        'ECDSAKeyUsage-Client-TLS13',
        'RSAKeyUsage-Client-WantSignature-GotEncipherment-TLS13',
      ].includes(row.name),
  },
  {
    id: 'compliance-policy',
    why: "BoringSSL's certification modes — FIPS 140-3, CNSA 1.0 and 2.0, WPA3 — which restrict the same TLS 1.3 to a shorter list of algorithms and are a product feature of that library, not a property of a conformant client.",
    excludes: row => row.flags.some(flag => /^-(fips|cnsa\d|wpa)-\d+$/.test(flag)),
  },
  {
    id: 'older-tls-shape',
    why: 'The flag asks the client to speak a version other than 1.3, or for machinery that only exists below it: extended master secret, False Start, the `tls-unique` channel binding, which TLS 1.3 replaces with the exporter, and CBC record splitting — the TLS 1.0 BEAST mitigation, over a cipher mode TLS 1.3 does not have. BoGo runs the six splitting tests at `MaxVersion: VersionTLS10` (`cbc_tests.go`), and they sat in the manifest only because the shim exited 89 on `-write-different-record-sizes` before reaching this flag.',
    excludes: row =>
      hasAny(row.flags, [
        '-max-version',
        '-min-version',
        '-no-tls13',
        '-no-tls1',
        '-no-tls11',
        '-no-tls12',
        '-fallback-scsv',
        '-false-start',
        '-tls-unique',
        '-expect-extended-master-secret',
        '-cbc-record-splitting',
      ]),
  },
  {
    id: 'revocation-out-of-v1',
    why: 'ROADMAP puts stapled OCSP out of v1 and says why: checking a staple needs `status_request` in the ClientHello, the response parsed out of its `CertificateEntry`, and then its signature, responder authorisation and freshness verified — a second validator, with its own bypasses. v1 checks no revocation at all, which is a decision rather than an omission, and these tests come back with it.',
    excludes: row => row.flags.some(flag => flag.includes('ocsp')),
  },
  {
    id: 'not-in-this-client',
    why: "Extensions and credential types YOZZ will not grow. A TLS-level PSK or PAKE is a different trust model from a password sent to the mail server over an authenticated channel; Channel ID is a Google extension; SRTP is for media; certificate compression is an optimisation for a client that opens one connection per device; trust-anchor negotiation is a draft; server padding is BoringSSL's own. Certificate Transparency is the one with teeth, and ROADMAP already names it as knowingly absent — TOFU pinning is what stands in for it.",
    excludes: row =>
      hasAny(row.flags, [
        '-psk',
        '-psk-identity',
        '-new-psk-credential',
        '-new-spake2plusv1-credential',
        '-on-resume-new-spake2plusv1-credential',
        '-send-channel-id',
        '-enable-channel-id',
        '-srtp-profiles',
        '-install-cert-compression-algs',
        '-requested-trust-anchors',
        '-request-server-padding',
        '-enable-signed-cert-timestamps',
        '-expect-signed-cert-timestamps',
        '-signed-cert-timestamps',
      ]),
  },
  {
    id: 'not-our-connection-api',
    why: "BoGo drives an `SSL` object; this package hands the caller a `TlsConnection` with four methods — `read`, `write`, `close`, `exportKeyingMaterial`. Six flags ask for verbs that are not on it, three because the shape differs and three because the verb is deliberately withheld. **`-peek-then-read`** calls `SSL_peek` and then `SSL_read` and asserts they agree; `read()` returns an owned chunk rather than filling a caller's buffer, so the caller's own buffer IS the peek and there is nothing for a second method to do. **`-read-with-unfinished-write`** requires `-async` and a BIO that accepts ONE BYTE, leaving `SSL_write` in `WANT_WRITE` with a record half on the wire (`bssl_shim.cc`). `ByteDuplex.write` is all-or-nothing — a promise, never a byte count — so a half-written RECORD is not a state this transport can be in and the flag has nothing to configure. A review was right that the state a caller CAN reach is an un-awaited `write()` running concurrently with `read()`; that is a pending promise, not a partial record, and it is not what this flag asks for. **`-no-op-extra-handshake`** calls `SSL_do_handshake` again after the handshake, which TLS 1.3 makes a no-op; `startTls` returns a connection and there is no second call to make. Then the two that are refusals rather than shapes. **`-send-alert`** makes the shim send a fatal `decompression_failure` on demand: the alerts this client sends are the ones the protocol requires of it and it sends them itself, and a mail client has no application error TLS 1.3 names an alert for — the one case that looked like an exception, an M9 pin mismatch, is raised INSIDE the handshake by the validator and already leaves as `certificate_unknown`. **`-export-traffic-secrets`** hands out `SSL_get_traffic_secrets`, the raw application traffic secrets, which is a debugger's feature (SSLKEYLOGFILE) and an anti-feature in a mail client: any caller bug leaks the whole session. The legitimate need it looks like — channel binding for SCRAM-SHA-256-PLUS — is RFC 9846 §7.5's exporter, which IS built and whose BoGo tests pass. **`-key-update`** asks the CALLER to trigger a rekey on demand, and no caller here has a reason to. Read this as the API verb ONLY: RFC 9846 §5.5's \"MUST either close the connection or do a key update\" before AES-GCM's ~2^24.5-record limit is a different mechanism and it IS implemented — `write()` rekeys at `clientAppSeq >= 2^24`, comfortably under. An earlier draft of this rule claimed otherwise; a review checked the code.",
    excludes: row =>
      hasAny(row.flags, [
        '-peek-then-read',
        '-read-with-unfinished-write',
        '-no-op-extra-handshake',
        '-send-alert',
        '-export-traffic-secrets',
        '-key-update',
      ]),
  },
  {
    id: 'resumption-across-names',
    why: 'Offering one host\'s ticket to a DIFFERENT host, which draft-ietf-tls-tlsflags carries as the `resumption_across_names` bit in a `ticket_flags` extension — not in RFC 9846 at all. It is out on privacy rather than cost, and the position is already written into `TlsSession.serverName`: a ticket is an identifier the server hands out in the clear and sees again in the clear, so offering one to a second host tells that host where else we have been. `isSessionOfferable` refuses a name mismatch categorically, which is the safe answer the flag would have to ASK a server for. What the feature buys is one saved full handshake when a provider fronts many hostnames; what it costs is a correlatable identifier crossing a name boundary on the say-so of the party being told. `TLS13-Client-NonminimalTicketFlags` and `-EmptyTicketFlags` come in by name: they are malformed-`ticket_flags` tests, and §4.3\'s decode_error rule carves out exactly our case — "This does not apply if the receiver does not implement or is configured to ignore an extension." Nothing is parsed, so a padded or empty body is not ours to refuse. They were RFC_DIVERGENCES pending this decision, and this is the decision. **Two reviews argued `TLS13-Client-NoResumptionAcrossNames` should stay measured**, since a client that never resumes across names does answer `not resumable`. It leaves with its twin because of what the pair is FOR — the runner\'s own comment above them is "The client should parse the resumption_across_names flag" — and a shim answering a hardcoded `false` would pass the negative half while still failing `TLS13-Client-ResumptionAcrossNames`, which is precisely what proves the constant is not a parse. A tautological assertion is the thing `-expect-verify-result` was rewritten to remove.',
    excludes: row =>
      row.flags.some(flag => flag.includes('resumable-across-names')) ||
      ['TLS13-Client-NonminimalTicketFlags', 'TLS13-Client-EmptyTicketFlags'].includes(row.name),
  },
  {
    id: 'optional-hardening',
    why: "Two things a client MAY do, each weighed against what it buys THIS client and left out with the number that would change the answer. **GREASE** (RFC 8701, `-enable-grease`) sends reserved values so peers cannot ossify on one implementation's extension list — a benefit to the ecosystem and not to our user, paid for in ClientHello bytes. That price used to be sharper: a rule here tracked our ClientHello to the byte because it sat one short of the range RFC 7685 pads. `signature_algorithms_cert` pushed it in, the padding is implemented, and the rule is gone — so GREASE now costs bytes rather than a premise. **`-max-cert-list`** is BoringSSL's configurable ceiling (100KB by default) on how much certificate a server can make a client buffer. Ours is `MAX_HANDSHAKE_MESSAGE_BODY` and it is already a real cap — **65536**, chosen rather than inherited: `Handshake.length` is a uint24, so the RFC would allow 16MB, and a body declaring more than 64KB is refused from its HEADER before a byte of it is buffered. The risk this flag configures away is therefore already bounded; what BoGo wants is for the ceiling to be a caller's option, and no caller here has a reason to move it. An earlier draft of this rule said the cap WAS 2^24; a review read the constant. Both are additive later; neither is load-bearing now.",
    excludes: row => hasAny(row.flags, ['-enable-grease', '-max-cert-list']),
  },
  {
    id: 'rfc-divergence',
    why: 'Our behaviour follows the RFC and BoringSSL chose otherwise. Every entry carries the sentence it rests on — see RFC_DIVERGENCES above, which run.ts prints in full.',
    excludes: row => RFC_DIVERGENCES.some(divergence => divergence.test === row.name),
  },
  {
    id: 'chacha20',
    why: 'ROADMAP names ChaCha20-Poly1305 as deliberately never implemented. The two AES-GCM suites are what every mail host offers. Two tests are named by hand because their NAMES say nothing. `Resume-Client-CipherMismatch-TLS13` resumes at a config whose only suite is TLS_CHACHA20_POLY1305_SHA256 (`resumption_tests.go`), so the second handshake dies on `handshake_failure` before it can test what it exists to test — that TLS 1.3 may resume at a different suite with the same hash. `TLS13-CipherPreference-Client` is UNREACHABLE rather than unbuilt: it exists to check that a client orders ChaCha20-Poly1305 against AES-GCM by whether it has AES hardware, and pins the answer with `-expect-cipher-aes` or `-expect-cipher-no-aes` (`tls13_tests.go`). A client offering only the two AES-GCM suites has no ordering to get wrong and can only ever answer AES, so passing it would prove nothing. It returns with ChaCha20 or not at all.',
    excludes: row =>
      row.name.includes('CHACHA20') ||
      ['Resume-Client-CipherMismatch-TLS13', 'TLS13-CipherPreference-Client'].includes(row.name),
  },
  {
    id: 'post-quantum',
    why: 'ML-KEM key exchange and ML-DSA signatures, which DECISIONS puts out of v1 together. Three things stand behind it. No mail host offers a post-quantum group today, so there is nothing to interoperate with. WebCrypto has neither, so implementing them means shipping a JS or WASM Kyber into the security path — the one place this project has kept to primitives the platform provides. And a post-quantum GROUP under a classical certificate only defends against passive recording: an adversary who can break P-256 can forge the certificate and be in the middle live, so the pair is bought together or not at all. Adding a group later is purely additive, which is what makes waiting cheap.',
    excludes: row =>
      offersGroup(row, POST_QUANTUM_GROUPS) || offersScheme(row, POST_QUANTUM_SCHEMES),
  },
  {
    id: 'p-521',
    why: "P-521 as an ECDHE group and as ECDSA's curve, out of v1 with the two above. Unlike them it is cheap — WebCrypto does it natively — so the reason it is out is that nothing asks for it, and this is the exclusion that named its own reversal condition: M8's nine servers. **M8 ran, and the answer is no.** Eight of the nine selected X25519 and `posteo.de` selected secp384r1 after a HelloRetryRequest; not one offered P-521, in Node or in any of the three browser engines (`harness/live.ts`, `harness/browser/`). So the rule now stands on a measurement rather than on the absence of one — which is a stronger place for it, and moves the reversal condition to a mail host we have not met.",
    excludes: row => offersGroup(row, P521_GROUP) || offersScheme(row, P521_SCHEME),
  },
  {
    id: 'one-key-share',
    why: "This client sends exactly one key share, for the first group in `supportedGroups`, and BoGo asks for that to be configurable in both directions. `-key-shares` names a SUBSET of the offered groups to share for; `-no-key-shares` sends an empty `key_share` and takes a HelloRetryRequest on purpose. RFC 9846 §4.2.8 permits every shape, so this is a preference and not a rule. One share is right for this client's list — X25519, P-256 and P-384, and every mail host on the measured list takes the first — so a second share is a keypair generated to be thrown away, and zero shares is a guaranteed extra round trip. The knob would have exactly one caller, the shim. **It sits below `post-quantum` and `p-521` on purpose.** Several `CustomKeyShares-*` tests ask for a share on an ML-KEM group, and higher up this list the rule claimed nine of them — filing a test that is out because ML-KEM is out of v1 under a rule about how many shares we send. The predicate was wider than its stated reason, which is the third time this repo has paid for that; ordering is the fix, because the algorithm is the more specific answer. **`CustomKeyShares-DefaultSupportedGroups-TLS13` asks for a single X25519 share, which IS this client's default**, and two reviews flagged that the rule therefore takes a test we would pass. It would pass by coincidence rather than by honouring anything, and what it would measure — one share, for the first offered group — `handshake.test.ts` Gate C measures directly, without Go or the 337MB checkout.",
    excludes: row => hasAny(row.flags, ['-key-shares', '-no-key-shares']),
  },
];

export const excludedBy = (row: InventoryRow): ScopeRule | undefined =>
  SCOPE_RULES.find(rule => rule.excludes(row));
