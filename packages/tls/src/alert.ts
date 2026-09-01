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
  /** RFC 9846 §6: an unknown alert type is an error alert; the code is reported rather than answered. */
  | { readonly kind: 'alert-received-unknown'; readonly code: number }
  | { readonly kind: 'truncated' }
  | {
      readonly kind: 'certificate';
      readonly reason: ValidationFailure;
      readonly alert: Alert;
      /**
       * `'session-stored'` (re-checked under `reverifyOnResume`) usually means a stale session: evict
       * it and reconnect. `'peer-sent'` means the host presents something we refuse, and a retry
       * achieves nothing.
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
  // §6.2: a CA that "could not be matched with a known trust anchor", for this chain.
  'certificate-authority-distrusted': 'unknown_ca',
  // §6.2: "some other (unspecified) issue"; the chain itself was fine.
  'rejected-by-policy': 'certificate_unknown',
};

export const alertForValidationFailure = (failure: ValidationFailure): Alert => ({
  level: 'fatal',
  description: VALIDATION_FAILURE_ALERTS[failure.code],
});
