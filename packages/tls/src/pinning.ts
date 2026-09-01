/**
 * Trust on first use on the leaf's public key, on top of CA validation. Learning a pin is the
 * caller's move, from `HandshakeResult.peerPublicKeyPin` of a COMPLETED handshake: certificates are
 * public and replayable, and only CertificateVerify proves the peer holds the key.
 */

import type { Validator } from '@yozz.app/x509';

/** RFC 7469 §2.1.1: base64 of SHA-256 over the SPKI DER. A string, so it survives the caller's JSON store. */
export const publicKeyPin = async (subjectPublicKeyInfoDer: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(subjectPublicKeyInfoDer));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

/**
 * The inner validator runs first and its failure is returned untouched. A mismatch is
 * `rejected-by-policy`: the chain is fine. `pin` is required; a caller without one passes the
 * unwrapped validator. One instance per connection.
 */
export const pinnedValidator = ({
  validator,
  pin,
}: {
  readonly validator: Validator;
  readonly pin: string;
}): Validator => ({
  name: `${validator.name}+spki-pin`,
  validatePath: async request => {
    const result = await validator.validatePath(request);
    if (!result.ok) return result;

    const seen = await publicKeyPin(result.path.leafSubjectPublicKeyInfoDer);
    if (seen !== pin) return { ok: false, reason: { code: 'rejected-by-policy' } };

    return result;
  },
});
