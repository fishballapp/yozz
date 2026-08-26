/**
 * TLS 1.3 protocol wire constants and code-point tables (RFC 9846).
 */

export type ContentType = 'change_cipher_spec' | 'alert' | 'handshake' | 'application_data';

export const CONTENT_TYPES: Readonly<Record<ContentType, number>> = {
  change_cipher_spec: 0x14,
  alert: 0x15,
  handshake: 0x16,
  application_data: 0x17,
};

export type HandshakeType =
  | 'client_hello'
  | 'server_hello'
  | 'new_session_ticket'
  | 'end_of_early_data'
  | 'encrypted_extensions'
  | 'certificate'
  | 'certificate_request'
  | 'certificate_verify'
  | 'finished'
  | 'key_update'
  | 'message_hash';

export const HANDSHAKE_TYPES: Readonly<Record<HandshakeType, number>> = {
  client_hello: 1,
  server_hello: 2,
  new_session_ticket: 4,
  end_of_early_data: 5,
  encrypted_extensions: 8,
  certificate: 11,
  certificate_request: 13,
  certificate_verify: 15,
  finished: 20,
  key_update: 24,
  message_hash: 254,
};

export type NamedGroup = 'x25519' | 'secp256r1' | 'secp384r1';

export const NAMED_GROUPS: Readonly<Record<NamedGroup, number>> = {
  secp256r1: 0x0017,
  secp384r1: 0x0018,
  x25519: 0x001d,
};

/**
 * Every group this client implements, in the order it offers them — so the
 * first one carries the key share, and a server that accepts our first choice
 * negotiates without a HelloRetryRequest.
 *
 * P-384 is not optional here: `posteo.de` refuses X25519 and P-256 outright.
 *
 * It doubles as the default for `supportedGroups`, and `wire.test.ts` holds it
 * to covering every key of `NAMED_GROUPS` — `namedGroupFromCode` searches this
 * list, so a group implemented but missing from it would decode as unknown.
 */
export const SUPPORTED_GROUPS: readonly NamedGroup[] = ['x25519', 'secp256r1', 'secp384r1'];

/** The wire code back to the name, `undefined` for a group we do not implement. */
export const namedGroupFromCode = (code: number): NamedGroup | undefined =>
  SUPPORTED_GROUPS.find(name => NAMED_GROUPS[name] === code);

export type SignatureScheme =
  | 'ecdsa_secp256r1_sha256'
  | 'ecdsa_secp384r1_sha384'
  | 'rsa_pss_rsae_sha256'
  | 'rsa_pss_rsae_sha384'
  | 'rsa_pss_rsae_sha512'
  | 'ed25519';

export const SIGNATURE_SCHEMES: Readonly<Record<SignatureScheme, number>> = {
  ecdsa_secp256r1_sha256: 0x0403,
  ecdsa_secp384r1_sha384: 0x0503,
  rsa_pss_rsae_sha256: 0x0804,
  rsa_pss_rsae_sha384: 0x0805,
  rsa_pss_rsae_sha512: 0x0806,
  ed25519: 0x0807,
};

/**
 * Every scheme this client can verify a CertificateVerify with, in the order it
 * offers them, and the default for `signatureSchemes`.
 *
 * The list is the security boundary, not just a preference: RFC 9846 §4.5.2
 * says a server's "signature algorithm MUST be one offered in the client's
 * `signature_algorithms` extension", and the handshake refuses one that is not.
 * So a scheme missing from here is a scheme the server may not sign with, and a
 * scheme present but unimplemented in `verify.ts` is a hole — `wire.test.ts`
 * holds this to covering every key of `SIGNATURE_SCHEMES`, the same way
 * `SUPPORTED_GROUPS` is held to `NAMED_GROUPS`.
 *
 * Ed25519 is offered where BoringSSL disables it by default. It is a smaller,
 * misuse-resistant signature over a curve we already carry for key exchange,
 * and refusing it would only push a server onto RSA.
 */
export const SUPPORTED_SIGNATURE_SCHEMES: readonly SignatureScheme[] = [
  'ecdsa_secp256r1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha256',
  'rsa_pss_rsae_sha384',
  'rsa_pss_rsae_sha512',
  'ed25519',
];

/** The wire code back to the name, `undefined` for a scheme we do not implement. */
export const signatureSchemeFromCode = (code: number): SignatureScheme | undefined =>
  SUPPORTED_SIGNATURE_SCHEMES.find(name => SIGNATURE_SCHEMES[name] === code);

/**
 * The schemes `signature_algorithms_cert` offers — which certificate signatures
 * this client can verify, and a DIFFERENT question from the one
 * `SUPPORTED_SIGNATURE_SCHEMES` answers.
 *
 * RFC 9846 §4.3.3 draws the line: `signature_algorithms` "applies to signatures
 * in CertificateVerify messages", `signature_algorithms_cert` "applies to
 * signatures in certificates", and "if no `signature_algorithms_cert` extension
 * is present, then the `signature_algorithms` extension also applies to
 * signatures appearing in certificates". **Sending one list for both was a
 * defect, not a simplification**: it advertised RSA-PSS and Ed25519, which
 * `@yozz.app/x509` refuses in a chain, and withheld RSA-PKCS1, which signs most of
 * the real WebPKI. §4.5.1.2 turns the first half into a broken handshake — "All
 * certificates provided by the sender MUST be signed by a signature algorithm
 * advertised by the peer, if it is able to provide such a chain" — so a CA able
 * to present a PSS chain was told to prefer the one we would refuse.
 *
 * A separate TYPE, not three more names in `SignatureScheme`, and that is
 * load-bearing. `signatureSchemeFromCode` is what the handshake uses to refuse a
 * CertificateVerify, and RSA-PKCS1 returning a name there instead of `undefined`
 * would make this client accept a signature §4.3.3 says is "not defined for use
 * in signed TLS handshake messages". The two overlapping ECDSA names carry the
 * same code point in both tables, and `wire.test.ts` holds them to it.
 *
 * The OIDs are here so a test can compare this table against the ONE place that
 * knows the answer — `CERTIFICATE_SIGNATURE_ALGORITHM_OIDS` in `@yozz.app/x509`,
 * which is that package's own vocabulary because it may never learn TLS's.
 */
export type CertificateSignatureScheme =
  | 'ecdsa_secp256r1_sha256'
  | 'ecdsa_secp384r1_sha384'
  | 'ecdsa_secp521r1_sha512'
  | 'rsa_pkcs1_sha256'
  | 'rsa_pkcs1_sha384'
  | 'rsa_pkcs1_sha512';

export const CERTIFICATE_SIGNATURE_SCHEMES: Readonly<
  Record<
    CertificateSignatureScheme,
    {
      readonly code: number;
      readonly algorithmOid: string;
      /** `null` for RSA, whose key is not on a curve. */
      readonly curveOid: string | null;
    }
  >
> = {
  ecdsa_secp256r1_sha256: {
    code: 0x0403,
    algorithmOid: '1.2.840.10045.4.3.2',
    curveOid: '1.2.840.10045.3.1.7',
  },
  ecdsa_secp384r1_sha384: {
    code: 0x0503,
    algorithmOid: '1.2.840.10045.4.3.3',
    curveOid: '1.3.132.0.34',
  },
  /**
   * P-521 as a CERTIFICATE signature, which is not the P-521 that DECISIONS puts
   * out of v1. That one is the ECDHE group and the CertificateVerify scheme —
   * things a peer negotiates with us. This is a curve an intermediate we did not
   * choose may already have been signed with, and `@yozz.app/x509` verifies it, so
   * withholding it would understate the validator for no gain.
   */
  ecdsa_secp521r1_sha512: {
    code: 0x0603,
    algorithmOid: '1.2.840.10045.4.3.4',
    curveOid: '1.3.132.0.35',
  },
  rsa_pkcs1_sha256: {
    code: 0x0401,
    algorithmOid: '1.2.840.113549.1.1.11',
    curveOid: null,
  },
  rsa_pkcs1_sha384: {
    code: 0x0501,
    algorithmOid: '1.2.840.113549.1.1.12',
    curveOid: null,
  },
  rsa_pkcs1_sha512: {
    code: 0x0601,
    algorithmOid: '1.2.840.113549.1.1.13',
    curveOid: null,
  },
};

/**
 * What goes on the wire, in preference order. ECDSA first because those chains
 * are smaller and this client pays for every byte of a mail server's flight;
 * RSA-PKCS1 after, because that is what most of the WebPKI is actually signed
 * with and a server MUST be able to find it here.
 */
export const OFFERED_CERTIFICATE_SIGNATURE_SCHEMES: readonly CertificateSignatureScheme[] = [
  'ecdsa_secp256r1_sha256',
  'ecdsa_secp384r1_sha384',
  'ecdsa_secp521r1_sha512',
  'rsa_pkcs1_sha256',
  'rsa_pkcs1_sha384',
  'rsa_pkcs1_sha512',
];

export type ExtensionType =
  | 'server_name'
  | 'supported_groups'
  | 'signature_algorithms'
  | 'signature_algorithms_cert'
  | 'padding'
  | 'pre_shared_key'
  | 'early_data'
  | 'supported_versions'
  | 'cookie'
  | 'psk_key_exchange_modes'
  | 'key_share';

export const EXTENSION_TYPES: Readonly<Record<ExtensionType, number>> = {
  server_name: 0,
  supported_groups: 10,
  signature_algorithms: 13,
  signature_algorithms_cert: 50,
  /** RFC 7685. Sent, never read: a server has no reason to echo it. */
  padding: 21,
  pre_shared_key: 41,
  early_data: 42,
  supported_versions: 43,
  cookie: 44,
  psk_key_exchange_modes: 45,
  key_share: 51,
};

/**
 * RFC 9846 §4.3.9. This client offers `psk_dhe_ke` alone: `psk_ke` resumes with
 * no fresh key exchange, so one stolen ticket decrypts every session that ever
 * used it. Forward secrecy is the reason to run our own TLS in the first place.
 */
export const PSK_KEY_EXCHANGE_MODES = {
  psk_ke: 0,
  psk_dhe_ke: 1,
} as const;

export type AlertDescription =
  | 'close_notify'
  | 'unexpected_message'
  | 'bad_record_mac'
  | 'record_overflow'
  | 'handshake_failure'
  | 'bad_certificate'
  | 'unsupported_certificate'
  | 'certificate_expired'
  | 'certificate_unknown'
  | 'certificate_revoked'
  | 'unknown_ca'
  | 'illegal_parameter'
  | 'access_denied'
  | 'decode_error'
  | 'decrypt_error'
  | 'protocol_version'
  | 'insufficient_security'
  | 'internal_error'
  | 'inappropriate_fallback'
  | 'user_canceled'
  | 'missing_extension'
  | 'unsupported_extension'
  | 'unrecognized_name'
  | 'bad_certificate_status_response'
  | 'unknown_psk_identity'
  | 'certificate_required'
  | 'general_error'
  | 'no_application_protocol';

export const ALERT_DESCRIPTIONS: Readonly<Record<AlertDescription, number>> = {
  close_notify: 0,
  unexpected_message: 10,
  bad_record_mac: 20,
  record_overflow: 22,
  handshake_failure: 40,
  bad_certificate: 42,
  unsupported_certificate: 43,
  certificate_revoked: 44,
  certificate_expired: 45,
  certificate_unknown: 46,
  illegal_parameter: 47,
  unknown_ca: 48,
  access_denied: 49,
  decode_error: 50,
  decrypt_error: 51,
  protocol_version: 70,
  insufficient_security: 71,
  internal_error: 80,
  inappropriate_fallback: 86,
  user_canceled: 90,
  missing_extension: 109,
  unsupported_extension: 110,
  unrecognized_name: 112,
  bad_certificate_status_response: 113,
  unknown_psk_identity: 115,
  certificate_required: 116,
  // New in RFC 9846 §6.2 — "an error condition in cases when the peer should
  // not learn the specific cause". A conforming peer can send it today, and
  // without it here that peer reads as an unknown alert code.
  general_error: 117,
  no_application_protocol: 120,
};

export const LEGACY_RECORD_VERSION = {
  FIRST_CLIENT_HELLO: 0x0301,
  STANDARD: 0x0303,
} as const;

export const TLS_VERSION = {
  V1_0: 0x0301,
  V1_2: 0x0303,
  V1_3: 0x0304,
} as const;

/**
 * RFC 9846 §4.2.3: SHA-256("HelloRetryRequest")
 */
export const HRR_MAGIC_RANDOM: Uint8Array<ArrayBuffer> = Uint8Array.of(
  0xcf,
  0x21,
  0xad,
  0x74,
  0xe5,
  0x9a,
  0x61,
  0x11,
  0xbe,
  0x1d,
  0x8c,
  0x02,
  0x1e,
  0x65,
  0xb8,
  0x91,
  0xc2,
  0xa2,
  0x11,
  0x16,
  0x7a,
  0xbb,
  0x8c,
  0x5e,
  0x07,
  0x9e,
  0x09,
  0xe2,
  0xc8,
  0xa8,
  0x33,
  0x9c,
);

/**
 * RFC 9846 §4.2.3: Downgrade sentinels in the last 8 octets of ServerHello.random.
 */
export const DOWNGRADE_SENTINEL_TLS_1_2: Uint8Array<ArrayBuffer> = Uint8Array.of(
  0x44,
  0x4f,
  0x57,
  0x4e,
  0x47,
  0x52,
  0x44,
  0x01,
);

export const DOWNGRADE_SENTINEL_TLS_1_1: Uint8Array<ArrayBuffer> = Uint8Array.of(
  0x44,
  0x4f,
  0x57,
  0x4e,
  0x47,
  0x52,
  0x44,
  0x00,
);
