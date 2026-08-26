/**
 * What `@yozz.app/tls` may import. Everything else is internal.
 *
 * `decodeDer` and `decodeInteger` are here for one reason: ECDSA signatures
 * arrive from the wire as a DER `SEQUENCE { r, s }` and WebCrypto wants fixed
 * width, and a SECOND DER parser in the security path is exactly the thing this
 * package exists to avoid.
 */
export {
  type AnchorIndexEntry,
  type CompiledAnchors,
  compileAnchors,
  indexAnchors,
} from './anchors.ts';
export type { Certificate, GeneralName, Name, SubjectPublicKeyInfo } from './certificate.ts';
export { decodeCertificate } from './certificate.ts';
/**
 * The builder, for test rigs that need a real signed chain. `@yozz.app/tls` stands a
 * local TLS 1.3 server on one, so its client is checked by YOZZ_VALIDATOR
 * against a real root rather than by a test double. It only issues certificates;
 * nothing here validates one.
 */
export { type IssuedCertificate, issueCertificate, SERVER_AUTH } from './certificate-builder.ts';
export { DerError, type DerFailureCode, type DerNode, decodeDer, decodeInteger } from './der.ts';
/**
 * Exported so `@yozz.app/tls` folds a hostname the same way this package does when
 * it decides whether a stored session belongs to the host being dialled. Two
 * implementations of one security comparison is two chances to disagree, and
 * `String.toLowerCase()` is not this: it is full Unicode, so KELVIN SIGN folds
 * to `k` and widens what matches.
 */
export { asciiLower } from './names.ts';
/**
 * The shipped trust store, compiled from curl's `cacert.pem` and NSS's cutoffs by
 * `pnpm -F @yozz.app/x509 anchors:build`. A browser has no `node:tls` root store, so
 * this is what carries real traffic there.
 */
export { ROOT_BUNDLE } from './root-bundle-generated.ts';
export { YOZZ_VALIDATOR } from './validate.ts';
export type {
  PathValidationRequest,
  PathValidationResult,
  PeerName,
  TrustAnchor,
  TrustAnchorSource,
  ValidatedPath,
  ValidationFailure,
  Validator,
} from './validator.ts';
export {
  CERTIFICATE_CURVE_OIDS,
  CERTIFICATE_SIGNATURE_ALGORITHM_OIDS,
} from './verify.ts';
