/**
 * What YOZZ may import from `@yozz.app/tls`. Everything else is internal.
 *
 * The key schedule is exported because the handshake is built on top of it and
 * the RFC 8448 gate drives it directly — not because anything above this package
 * has a use for a raw secret.
 */

export type {
  Alert,
  AlertDescription,
  TlsFailure,
} from './alert.ts';
export {
  type HandshakeResult,
  type StartTlsOptions,
  startTls,
  type TlsCloseResult,
  type TlsConnection,
  type TlsReadResult,
  type TlsWriteResult,
} from './handshake.ts';
export {
  CIPHER_SUITES,
  type CipherSuite,
  deriveSecret,
  earlySecret,
  finishedKey,
  handshakeSecret,
  hkdfExpandLabel,
  hkdfExtract,
  isVerifyDataValid,
  masterSecret,
  type TrafficKeys,
  trafficKeys,
  transcriptHash,
  verifyData,
} from './key-schedule.ts';

/**
 * Trust on first use. The check is a `Validator` wrapper so a pin mismatch
 * refuses the connection where every other certificate refusal does; the learn
 * half is `HandshakeResult.peerPublicKeyPin`, which only a completed handshake
 * has.
 */
export { pinnedValidator, publicKeyPin } from './pinning.ts';
export type { TlsSession } from './session.ts';
export type { ByteDuplex } from './transport.ts';
export {
  NAMED_GROUPS,
  type NamedGroup,
  namedGroupFromCode,
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  signatureSchemeFromCode,
} from './wire.ts';
