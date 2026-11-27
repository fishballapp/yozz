export type ContentType = 'change_cipher_spec' | 'alert' | 'handshake' | 'application_data';

export const CONTENT_TYPES: Readonly<Record<ContentType, number>> = {
  change_cipher_spec: 0x14,
  alert: 0x15,
  handshake: 0x16,
  application_data: 0x17,
};

export type HandshakeType =
  | 'hello_request'
  | 'client_hello'
  | 'server_hello'
  | 'new_session_ticket'
  | 'end_of_early_data'
  | 'encrypted_extensions'
  | 'certificate'
  | 'server_key_exchange'
  | 'certificate_request'
  | 'server_hello_done'
  | 'certificate_verify'
  | 'client_key_exchange'
  | 'finished'
  | 'key_update'
  | 'message_hash';

export const HANDSHAKE_TYPES: Readonly<Record<HandshakeType, number>> = {
  /** TLS 1.2 only, RFC 5246 §7.4.1.1. */
  hello_request: 0,
  client_hello: 1,
  server_hello: 2,
  new_session_ticket: 4,
  end_of_early_data: 5,
  encrypted_extensions: 8,
  certificate: 11,
  /** TLS 1.2 only, RFC 5246 §7.4.3. */
  server_key_exchange: 12,
  certificate_request: 13,
  /** TLS 1.2 only, RFC 5246 §7.4.5. */
  server_hello_done: 14,
  certificate_verify: 15,
  /** TLS 1.2 only, RFC 5246 §7.4.7. */
  client_key_exchange: 16,
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

/** In offer order; the first carries the key share. P-384 is required: `posteo.de` refuses X25519 and P-256. */
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
 * The security boundary, not a preference: RFC 9846 §4.5.2 lets a server sign a CertificateVerify
 * only with a scheme offered here. Ed25519 is offered though BoringSSL disables it by default.
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

export type TlsProtocolVersion = 'TLS 1.2' | 'TLS 1.3';

export type LegacyRsaSignatureScheme = 'rsa_pkcs1_sha256' | 'rsa_pkcs1_sha384' | 'rsa_pkcs1_sha512';

/**
 * What a TLS 1.2 ServerKeyExchange may be signed with. A separate type from `SignatureScheme`, so
 * RSA-PKCS1 never becomes a TLS 1.3 CertificateVerify scheme (RFC 9846 §4.5.2). Under TLS 1.2 the
 * ECDSA codes name a hash only, not a curve (RFC 5246 §7.4.1.4.1).
 */
export type Tls12SignatureScheme = SignatureScheme | LegacyRsaSignatureScheme;

export const TLS_1_2_SIGNATURE_SCHEMES: Readonly<Record<Tls12SignatureScheme, number>> = {
  ...SIGNATURE_SCHEMES,
  rsa_pkcs1_sha256: 0x0401,
  rsa_pkcs1_sha384: 0x0501,
  rsa_pkcs1_sha512: 0x0601,
};

/** RSA-PKCS1 last: many TLS 1.2 servers sign with nothing else, but every modern scheme beats it. */
export const SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES: readonly Tls12SignatureScheme[] = [
  ...SUPPORTED_SIGNATURE_SCHEMES,
  'rsa_pkcs1_sha256',
  'rsa_pkcs1_sha384',
  'rsa_pkcs1_sha512',
];

/** The wire code back to the name, `undefined` for a scheme we do not implement under TLS 1.2. */
export const tls12SignatureSchemeFromCode = (code: number): Tls12SignatureScheme | undefined =>
  SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES.find(name => TLS_1_2_SIGNATURE_SCHEMES[name] === code);

/** Ephemeral ECDHE with AES-GCM only: no CBC, no RSA key exchange, no DHE. */
export type Tls12CipherSuite =
  | 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256'
  | 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256'
  | 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384'
  | 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384';

export type Tls12CipherSuiteParameters = {
  readonly code: number;
  /** The PRF's hash (RFC 5246 §5; RFC 5289 §3). */
  readonly hash: 'SHA-256' | 'SHA-384';
  readonly hashLength: 32 | 48;
  readonly keyLength: 16 | 32;
  /** RFC 5288 §3: the salt half of the GCM nonce, from the key block. */
  readonly implicitIvLength: 4;
  /** RFC 5288 §3: the half sent in each record. */
  readonly explicitNonceLength: 8;
  /** What the server's certificate key must be. */
  readonly auth: 'ecdsa' | 'rsa';
};

export const TLS_1_2_CIPHER_SUITES: Readonly<Record<Tls12CipherSuite, Tls12CipherSuiteParameters>> =
  {
    TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: {
      code: 0xc02b,
      hash: 'SHA-256',
      hashLength: 32,
      keyLength: 16,
      implicitIvLength: 4,
      explicitNonceLength: 8,
      auth: 'ecdsa',
    },
    TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: {
      code: 0xc02f,
      hash: 'SHA-256',
      hashLength: 32,
      keyLength: 16,
      implicitIvLength: 4,
      explicitNonceLength: 8,
      auth: 'rsa',
    },
    TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: {
      code: 0xc02c,
      hash: 'SHA-384',
      hashLength: 48,
      keyLength: 32,
      implicitIvLength: 4,
      explicitNonceLength: 8,
      auth: 'ecdsa',
    },
    TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: {
      code: 0xc030,
      hash: 'SHA-384',
      hashLength: 48,
      keyLength: 32,
      implicitIvLength: 4,
      explicitNonceLength: 8,
      auth: 'rsa',
    },
  };

/** In offer order: AES-128 first, as for TLS 1.3. */
export const SUPPORTED_TLS_1_2_CIPHER_SUITES: readonly Tls12CipherSuite[] = [
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
];

/** The wire code back to the name, `undefined` for a suite we do not implement. */
export const tls12SuiteFromCode = (code: number): Tls12CipherSuite | undefined =>
  SUPPORTED_TLS_1_2_CIPHER_SUITES.find(name => TLS_1_2_CIPHER_SUITES[name].code === code);

/**
 * What `signature_algorithms_cert` offers (RFC 9846 §4.3.3): the certificate signatures
 * `@yozz.app/x509` can verify. A separate type, so RSA-PKCS1 never becomes a CertificateVerify
 * scheme. The OIDs let `wire.test.ts` compare this against x509's own table.
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
  // A curve an intermediate may already be signed with; not the P-521 group, which is out of v1.
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

/** ECDSA first, for smaller chains. RSA-PKCS1 must be here: most of the WebPKI is signed with it. */
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
  | 'ec_point_formats'
  | 'signature_algorithms'
  | 'signature_algorithms_cert'
  | 'padding'
  | 'extended_master_secret'
  | 'pre_shared_key'
  | 'early_data'
  | 'supported_versions'
  | 'cookie'
  | 'psk_key_exchange_modes'
  | 'key_share'
  | 'renegotiation_info';

export const EXTENSION_TYPES: Readonly<Record<ExtensionType, number>> = {
  server_name: 0,
  supported_groups: 10,
  /** RFC 8422 §5.1.2. TLS 1.2 only; uncompressed is the one format left. */
  ec_point_formats: 11,
  signature_algorithms: 13,
  signature_algorithms_cert: 50,
  /** RFC 7685. Sent, never read: a server has no reason to echo it. */
  padding: 21,
  /** RFC 7627. TLS 1.2 only. */
  extended_master_secret: 23,
  pre_shared_key: 41,
  early_data: 42,
  supported_versions: 43,
  cookie: 44,
  psk_key_exchange_modes: 45,
  key_share: 51,
  /** RFC 5746. TLS 1.2 only: sent empty, to say we never renegotiate. */
  renegotiation_info: 65281,
};

/** RFC 9846 §4.3.9. Only `psk_dhe_ke` is offered: `psk_ke` gives up forward secrecy. */
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
  | 'no_renegotiation'
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
  /** RFC 5246 §7.2.2. TLS 1.2 only. */
  no_renegotiation: 100,
  missing_extension: 109,
  unsupported_extension: 110,
  unrecognized_name: 112,
  bad_certificate_status_response: 113,
  unknown_psk_identity: 115,
  certificate_required: 116,
  // New in RFC 9846 §6.2.
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

/** RFC 9846 §4.2.3: SHA-256("HelloRetryRequest"). */
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

/** RFC 9846 §4.2.3: the last 8 octets of ServerHello.random. */
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
