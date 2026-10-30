import { describe, expect, it } from 'vitest';
import {
  CliApproveQuerySchema,
  CliLoginCallbackSchema,
  CliLoginPayloadSchema,
  CliTokenSchema,
  CreateCliKeyRequestSchema,
  formatCliToken,
  X25519PublicKeySchema,
} from './index.ts';

const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SECRET = 'q_7Rt-0aZb3kLmN9pQrStUvWxYz0123456789abcdEf';
/** RFC 7748 §6.1's Alice public key, base64url. */
const PUBLIC_KEY = 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo';
const STATE = 'b'.repeat(43);

describe('CLI keys on the wire', () => {
  it('reads back the key id of a token it formatted', () => {
    const token = formatCliToken({ keyId: KEY_ID, secret: SECRET });

    expect(token).toBe(`yozzcli_${KEY_ID}_${SECRET}`);
    expect(CliTokenSchema.parse(token)).toEqual({ token, keyId: KEY_ID });
  });

  it('refuses a token with another prefix, key id or secret length', () => {
    for (const token of [
      `yozzcly_${KEY_ID}_${SECRET}`,
      `yozzcli_${KEY_ID.toUpperCase()}_${SECRET}`,
      `yozzcli_${KEY_ID}_${SECRET}A`,
      `yozzcli_${KEY_ID}_${SECRET.slice(1)}`,
      `yozzcli_${KEY_ID}_${SECRET}\n`,
      `Bearer yozzcli_${KEY_ID}_${SECRET}`,
    ]) {
      expect(CliTokenSchema.safeParse(token).success, token).toBe(false);
    }
  });

  it('takes a public key as exactly one spelling of 32 bytes', () => {
    expect(Uint8Array.fromBase64(PUBLIC_KEY, { alphabet: 'base64url' })).toHaveLength(32);
    expect(X25519PublicKeySchema.parse(PUBLIC_KEY)).toBe(PUBLIC_KEY);

    for (const key of [
      `${PUBLIC_KEY}=`,
      PUBLIC_KEY.slice(1),
      `A${PUBLIC_KEY}`,
      // The same bytes with a spare bit set.
      `${PUBLIC_KEY.slice(0, -1)}p`,
      PUBLIC_KEY.replace('_', '/'),
    ]) {
      expect(X25519PublicKeySchema.safeParse(key).success, key).toBe(false);
    }
  });

  it('holds a name to the passkey-name limit, trimmed', () => {
    const body = {
      publicKey: PUBLIC_KEY,
      ephemeralPublicKey: PUBLIC_KEY,
      wrappedDek: 'd3JhcA==',
    };
    expect(CreateCliKeyRequestSchema.parse({ ...body, name: '  laptop  ' }).name).toBe('laptop');
    expect(CreateCliKeyRequestSchema.safeParse({ ...body, name: 'x'.repeat(61) }).success).toBe(
      false,
    );
    expect(CreateCliKeyRequestSchema.safeParse({ ...body, name: '   ' }).success).toBe(false);
    expect(
      CreateCliKeyRequestSchema.safeParse({ ...body, name: 'laptop', token: 'x' }).success,
    ).toBe(false);
  });

  it('parses the approve page query from a URL', () => {
    const query = Object.fromEntries(
      new URLSearchParams({ port: '53682', state: STATE, publicKey: PUBLIC_KEY, name: 'ci' }),
    );

    expect(CliApproveQuerySchema.parse(query)).toEqual({
      port: 53682,
      state: STATE,
      publicKey: PUBLIC_KEY,
      name: 'ci',
    });
    for (const port of ['80', '65536', '5368.2', '']) {
      expect(CliApproveQuerySchema.safeParse({ ...query, port }).success, port).toBe(false);
    }
  });

  it('parses an approved callback and a denied one, and nothing between', () => {
    const approved = { state: STATE, ephemeralPublicKey: PUBLIC_KEY, sealedLogin: 'c2VhbGVk+/A=' };

    expect(CliLoginCallbackSchema.parse(approved)).toEqual(approved);
    expect(CliLoginCallbackSchema.parse({ state: STATE, error: 'denied' })).toEqual({
      state: STATE,
      error: 'denied',
    });
    expect(CliLoginCallbackSchema.safeParse({ ...approved, error: 'denied' }).success).toBe(false);
    expect(CliLoginCallbackSchema.safeParse({ state: STATE, error: 'other' }).success).toBe(false);
    expect(CliLoginCallbackSchema.safeParse({ ...approved, token: 'plain' }).success).toBe(false);
  });

  it('takes a login payload of a token and the account it belongs to, and nothing else', () => {
    const payload = {
      token: formatCliToken({ keyId: KEY_ID, secret: SECRET }),
      userId: 'user-1',
      email: 'jason@example.com',
    };

    expect(CliLoginPayloadSchema.parse(payload)).toEqual(payload);
    expect(CliLoginPayloadSchema.safeParse({ ...payload, token: 'plain' }).success).toBe(false);
    expect(CliLoginPayloadSchema.safeParse({ ...payload, email: undefined }).success).toBe(false);
    expect(CliLoginPayloadSchema.safeParse({ ...payload, privateKey: 'x' }).success).toBe(false);
  });
});
