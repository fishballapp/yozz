import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step } from '../vectors/rfc8448.ts';
import { type AlertDescription, decodeAlert, encodeAlert } from './alert.ts';
import { ALERT_DESCRIPTIONS } from './wire.ts';

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

describe('Stage 1 — Alert encode/decode', () => {
  it('encodeAlert(close_notify warning) equals every published alert payload', () => {
    const encoded = encodeAlert({ level: 'warning', description: 'close_notify' });
    expect(encoded).toEqual(Uint8Array.of(0x01, 0x00));

    const payloads: Uint8Array[] = [];
    for (const trace of RFC_8448_TRACES) {
      for (const step of trace.steps) {
        if (step.title.includes('send alert record')) {
          const payload = bytesOf(step, 'payload');
          if (payload !== undefined) payloads.push(payload);
        }
      }
    }

    expect(payloads.length).toBe(10);
    for (const payload of payloads) {
      expect(payload).toEqual(encoded);
    }
  });

  it('decodeAlert round-trips the published close_notify payloads', () => {
    const encoded = encodeAlert({ level: 'warning', description: 'close_notify' });
    expect(decodeAlert(encoded)).toEqual({
      ok: true,
      alert: { level: 'warning', description: 'close_notify' },
    });
  });

  it('rejects 1-byte and 3-byte alert payloads with decode_error', () => {
    expect(decodeAlert(Uint8Array.of(0x01))).toEqual({
      ok: false,
      description: 'decode_error',
    });
    expect(decodeAlert(Uint8Array.of(0x01, 0x00, 0x00))).toEqual({
      ok: false,
      description: 'decode_error',
    });
  });

  it('gives every AlertDescription a unique wire code', () => {
    const codes = Object.values(ALERT_DESCRIPTIONS);
    expect(new Set(codes).size).toBe(codes.length);

    const required: readonly AlertDescription[] = [
      'close_notify',
      'unexpected_message',
      'bad_record_mac',
      'record_overflow',
      'handshake_failure',
      'bad_certificate',
      'unsupported_certificate',
      'certificate_expired',
      'certificate_unknown',
      'unknown_ca',
      'illegal_parameter',
      'decode_error',
      'decrypt_error',
      'protocol_version',
      'insufficient_security',
      'internal_error',
      'missing_extension',
      'unsupported_extension',
      'unrecognized_name',
      // RFC 9846's own addition to the list (§6.2).
      'general_error',
    ];
    for (const description of required) {
      expect(ALERT_DESCRIPTIONS[description]).toBeTypeOf('number');
    }
  });

  it('decodes general_error as itself, not as an unknown code', () => {
    expect(decodeAlert(Uint8Array.of(2, 117))).toEqual({
      ok: true,
      alert: { level: 'fatal', description: 'general_error' },
    });
  });
});
