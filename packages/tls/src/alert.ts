/**
 * TLS 1.3 Alert protocol encoding, decoding, and failure mapping (RFC 9846 §6).
 */

import type { ValidationFailure } from '@yozz.app/x509';
import { ALERT_DESCRIPTIONS, type AlertDescription } from './wire.ts';

export type { AlertDescription } from './wire.ts';

export type AlertLevel = 'warning' | 'fatal';

export type Alert = {
  readonly level: AlertLevel;
  readonly description: AlertDescription;
};

export type TlsFailure =
  | { readonly kind: 'alert-sent'; readonly alert: Alert }
  | { readonly kind: 'alert-received'; readonly alert: Alert }
  /**
   * A well-formed alert whose description TLS 1.3 does not define. RFC 9846 §6:
   * "Unknown Alert types MUST be treated as error alerts" — so the connection
   * ends, and what the peer said is reported rather than answered. Old servers
   * still send old alerts, and "the server sent alert 30" is a diagnosis where
   * "we sent illegal_parameter" is not.
   */
  | { readonly kind: 'alert-received-unknown'; readonly code: number }
  | { readonly kind: 'truncated' }
  | {
      readonly kind: 'certificate';
      readonly reason: ValidationFailure;
      readonly alert: Alert;
      /**
       * WHICH chain was refused, and it is the field a caller acts on.
       *
       * `'peer-sent'` is the chain this handshake received. `'session-stored'`
       * is the copy a resumed session carried, re-checked because
       * `reverifyOnResume` asked for it — and the two want opposite responses.
       * A stored chain that no longer validates usually means the mail host has
       * ROTATED and the session is stale, so the answer is to evict it and
       * reconnect without one, which will very likely succeed. The same
       * `ValidationFailure` on a peer-sent chain means the host is actually
       * presenting something we refuse, and retrying achieves nothing but a
       * second refusal.
       *
       * Two cross-model reviews landed on this independently: without it,
       * `kind: 'certificate'` is all a caller has, `certificate-expired` reads
       * as "this mail host's certificate expired" in both cases, and the
       * retry-and-recover path this library tells callers to own cannot be
       * written.
       */
      readonly chain: 'peer-sent' | 'session-stored';
    };

const CODE_TO_DESCRIPTION = new Map<number, AlertDescription>(
  (Object.entries(ALERT_DESCRIPTIONS) as readonly [AlertDescription, number][]).map(
    ([desc, code]) => [code, desc],
  ),
);

export const encodeAlert = (alert: Alert): Uint8Array<ArrayBuffer> => {
  const levelCode = alert.level === 'warning' ? 1 : 2;
  const descCode = ALERT_DESCRIPTIONS[alert.description];
  if (descCode === undefined) {
    throw new Error(`Unknown alert description: ${alert.description}`);
  }
  return Uint8Array.of(levelCode, descCode);
};

export type DecodeAlertResult =
  | { readonly ok: true; readonly alert: Alert }
  | {
      readonly ok: false;
      readonly description: 'decode_error' | 'illegal_parameter';
      /** Set when only the DESCRIPTION was unrecognised; see `TlsFailure`. */
      readonly unknownDescriptionCode?: number;
    };

export const decodeAlert = (bytes: Uint8Array): DecodeAlertResult => {
  if (bytes.length !== 2) {
    return { ok: false, description: 'decode_error' };
  }
  const levelCode = bytes[0];
  const descCode = bytes[1];
  if (levelCode === undefined || descCode === undefined) {
    return { ok: false, description: 'decode_error' };
  }

  const level: AlertLevel | undefined =
    levelCode === 1 ? 'warning' : levelCode === 2 ? 'fatal' : undefined;
  if (level === undefined) {
    return { ok: false, description: 'illegal_parameter' };
  }

  const description = CODE_TO_DESCRIPTION.get(descCode);
  if (description === undefined) {
    return { ok: false, description: 'illegal_parameter', unknownDescriptionCode: descCode };
  }

  return { ok: true, alert: { level, description } };
};

const VALIDATION_FAILURE_ALERTS: Readonly<Record<ValidationFailure['code'], AlertDescription>> = {
  'malformed-certificate': 'bad_certificate',
  'certificate-expired': 'certificate_expired',
  'certificate-not-yet-valid': 'certificate_expired',
  'unsupported-signature-algorithm': 'unsupported_certificate',
  'unknown-critical-extension': 'unsupported_certificate',
  'basic-constraints-violation': 'bad_certificate',
  'key-usage-violation': 'bad_certificate',
  'extended-key-usage-violation': 'bad_certificate',
  'name-constraints-violation': 'bad_certificate',
  'invalid-signature': 'bad_certificate',
  'name-mismatch': 'certificate_unknown',
  'no-path-to-trust-anchor': 'unknown_ca',
  'maximum-chain-depth-exceeded': 'unknown_ca',
  /**
   * §6.2's `unknown_ca` is "the certificate was not accepted because the CA
   * certificate could not be located or could not be matched with a known
   * trust anchor" — and a root distrusted for leaves this new is exactly a CA
   * that cannot be matched, for this chain, however well we know it. The
   * distinction the RFC has no alert for is kept where it is useful: in the
   * failure code the caller reads, not on the wire.
   */
  'certificate-authority-distrusted': 'unknown_ca',
  /**
   * RFC 9846 §6.2: "certificate_unknown: Some other (unspecified) issue arose
   * in processing the certificate, rendering it unacceptable." A validator
   * refusing on its own policy is exactly the unspecified issue — the chain
   * itself was fine, so none of the specific certificate alerts is true.
   */
  'rejected-by-policy': 'certificate_unknown',
};

export const alertForValidationFailure = (failure: ValidationFailure): Alert => ({
  level: 'fatal',
  description: VALIDATION_FAILURE_ALERTS[failure.code],
});
