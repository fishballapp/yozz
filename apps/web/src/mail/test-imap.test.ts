import { describe, expect, it, vi } from 'vitest';

vi.mock('./connection', () => ({
  connectImap: vi.fn(async (imap: { password: string }) =>
    imap.password === 'right'
      ? { ok: true, value: { client: {}, close: vi.fn(async () => {}) } }
      : { ok: false, error: { kind: 'auth', text: 'AUTHENTICATE failed' } },
  ),
}));

import { testImap } from './sync';

const record = (password: string) => ({
  host: 'imap.example.com',
  port: 993,
  username: 'me',
  password,
});

describe('testImap', () => {
  it('refuses a wrong password with the auth failure', async () => {
    const result = await testImap(record('wrong'));
    expect(result).toEqual({ ok: false, error: { kind: 'auth', text: 'AUTHENTICATE failed' } });
  });
  it('accepts a right one and closes the connection', async () => {
    const result = await testImap(record('right'));
    expect(result.ok).toBe(true);
  });
});
