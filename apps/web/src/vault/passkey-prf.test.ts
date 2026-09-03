import { describe, expect, it } from 'vitest';
import {
  checkPasskeyPrfCapability,
  extractPrfOutput,
  getPrfEnableInput,
  getPrfEvalInput,
  isPrfEnabled,
  PasskeyPrfError,
} from './passkey-prf';

describe('Web passkey PRF extension and derivation', () => {
  it('provides PRF extension inputs with standard label', () => {
    const inputs = getPrfEvalInput();
    expect(inputs.prf.eval.first).toBeInstanceOf(Uint8Array);
    const label = new TextDecoder().decode(inputs.prf.eval.first);
    expect(label).toBe('yozz-vault-prf-v1');
  });

  it('reports unsupported with no window, but UNKNOWN when only the probe is missing', async () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error test environment manipulation
    delete globalThis.window;
    expect(await checkPasskeyPrfCapability()).toBe('unsupported');

    // `getClientCapabilities` is Chrome 133+; its absence says nothing about PRF.
    globalThis.window = { PublicKeyCredential: {} } as unknown as Window & typeof globalThis;
    expect(await checkPasskeyPrfCapability()).toBe('unknown');

    globalThis.window = originalWindow;
  });

  it('accepts an authentication result, which carries no `enabled` flag', () => {
    // MDN's `get()` output has no `enabled`; requiring it rejected every real assertion.
    const bytes = new Uint8Array(32).fill(3);
    expect(extractPrfOutput({ prf: { results: { first: bytes.buffer } } })).toEqual(bytes);
  });

  it('accepts a plain Array, because 1Password ships one where the spec says BufferSource', () => {
    const bytes = new Uint8Array(32).fill(5);
    expect(extractPrfOutput({ prf: { results: { first: Array.from(bytes) } } })).toEqual(bytes);
  });

  it('reads `enabled` from a registration result and nothing else', () => {
    expect(isPrfEnabled({ prf: { enabled: true } })).toBe(true);
    expect(isPrfEnabled({ prf: { enabled: false } })).toBe(false);
    expect(isPrfEnabled({ prf: {} })).toBe(false);
    expect(isPrfEnabled(null)).toBe(false);
  });

  it('asks registration to ENABLE the PRF, never to evaluate it', () => {
    // `create()` does not reliably return PRF output, and `evalByCredential` makes it reject.
    expect(getPrfEnableInput()).toEqual({ prf: {} });
    expect(getPrfEvalInput().prf.eval.first).toBeInstanceOf(Uint8Array);
  });

  it('extracts PRF output when extension results are valid', () => {
    const firstBytes = new Uint8Array(32).fill(7);
    const results = {
      prf: {
        enabled: true,
        results: {
          first: firstBytes.buffer,
        },
      },
    };

    const extracted = extractPrfOutput(results);
    expect(extracted).toEqual(firstBytes);
  });

  it('throws PasskeyPrfError when PRF is not enabled or results are invalid', () => {
    expect(() => extractPrfOutput(null)).toThrow(PasskeyPrfError);
    expect(() => extractPrfOutput({})).toThrow(PasskeyPrfError);
    expect(() =>
      extractPrfOutput({
        prf: { results: {} },
      }),
    ).toThrow(PasskeyPrfError);

    expect(() =>
      extractPrfOutput({
        prf: {
          enabled: true,
          results: { first: new Uint8Array(16) },
        },
      }),
    ).toThrow(PasskeyPrfError);
  });
});
