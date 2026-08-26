/**
 * Trust on first use, pinned to the leaf's PUBLIC KEY.
 *
 * This sits on top of CA validation and never replaces it. What it catches is
 * the rogue-CA case — a certificate that chains to a root we ship, for a host
 * we have talked to before, carrying a key we have never seen. Path validation
 * accepts that chain and is right to: it is exactly what a misissued
 * certificate looks like, and with no Certificate Transparency and a root store
 * that updates on app releases, nothing else here would notice.
 *
 * **The KEY, not the certificate.** A public mail leaf reissues every 60-90
 * days, so a certificate pin alarms on every renewal, and an alarm that fires
 * on a routine event is one the user learns to click through — worse than no
 * pin at all. A renewal keeps the key by default, so a key pin is silent
 * through the event that happens every two months and speaks on the one that
 * should never happen unannounced.
 *
 * **Nothing here stores anything.** The pin store is the caller's, the same way
 * the session store is: it has to survive a page reload, it belongs to an
 * account, and a library that owns it would have to guess at all of that.
 *
 * ## The half this file does not do
 *
 * Learning a pin is the caller's move, from `HandshakeResult.peerPublicKeyPin`,
 * and it is available only from a handshake that COMPLETED. That is not a
 * convenience, it is the security property: a chain validating proves only that
 * someone sent bytes that chain to a trusted root, and certificates are public,
 * so anyone on the path can send them. An on-path attacker replaying the host's
 * previous certificate — still inside its validity, key since rotated — would
 * teach a validate-time pin the stale key and then fail at CertificateVerify,
 * and the user's next connection to the real host would alarm on a rotation
 * nobody performed. Cheap for an attacker, and it spends the one alarm this
 * mechanism has. CertificateVerify and Finished are what prove the peer HOLDS
 * the key, and they land after this file has already returned.
 */

import type { Validator } from '@yozz.app/x509';

/**
 * RFC 7469 §2.1.1's pin: base64 of SHA-256 over the SubjectPublicKeyInfo DER.
 *
 * A STRING, and that is the load-bearing part. The pin goes into a caller's
 * store, which for YOZZ means it is serialised and read back, and a
 * `Uint8Array` through `JSON.stringify` becomes `{"0":48,"1":89,...}` — an
 * object that revives as something no byte comparison will ever match, so every
 * reconnection reads as a rotation. It is also the format `openssl x509
 * -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary |
 * base64` prints, which is how a user checks a pin out of band.
 */
export const publicKeyPin = async (subjectPublicKeyInfoDer: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(subjectPublicKeyInfoDer));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

/**
 * A `Validator` that runs another one and then refuses any chain whose leaf key
 * is not the pinned one.
 *
 * The inner validator runs FIRST and its failure is returned untouched. A pin
 * that matched could otherwise carry an expired or unanchored chain through,
 * which would make pinning a way to weaken validation rather than a check on
 * top of it.
 *
 * A mismatch is `rejected-by-policy`, which `@yozz.app/tls` maps to a
 * `certificate_unknown` alert. It deliberately is not one of the codes that
 * name a property of the chain: the chain is fine. Reporting a rotated key as
 * `no-path-to-trust-anchor` would send a user to their CA over a problem that
 * has nothing to do with one.
 *
 * `pin` is required. There is no null-means-allow-anything mode, because that
 * is a pinned validator that silently never fires — a caller with no pin yet
 * passes the unwrapped validator and learns one from the result.
 *
 * **One per connection**, since a pin belongs to a host and the caller is the
 * one holding the store that maps between them. Reusing an instance across
 * hosts refuses the second one, which is the safe direction and still a bug.
 *
 * ONE pin, not a set. HPKP needed a backup pin to stop a browser bricking a
 * site it could not un-pin; a mismatch here asks the user, who can accept. The
 * case that would need a set is a hostname behind independently keyed
 * frontends, and every IP of all nine stage-3 mail hosts serves one key.
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
