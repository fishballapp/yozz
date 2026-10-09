import { env } from 'cloudflare:test';
import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { applyMigrations } from './apply-migrations.ts';

/** base64 of 32 bytes, the shape of `authValue`. */
const AUTH_VALUE = 'q0dGZ0Z0RGZnZGZnZGZnZGZnZGZnZGZnZGZnZGZnZGY=';

const signIn = async (email: string): Promise<{ userId: string; cookie: string }> => {
  let magicUrl = '';
  const app = createApp({
    emailSender: async mail => {
      magicUrl = mail.url;
    },
  });
  await app.request(
    'http://localhost/api/auth/sign-in/magic-link',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
      body: JSON.stringify({ email, name: email }),
    },
    env,
  );
  const verified = await app.request(magicUrl, { method: 'GET' }, env);
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error(`User not found for ${email}`);
  return { userId: user.id, cookie: verified.headers.get('set-cookie') ?? '' };
};

/** A passkey vault with one wrapped passkey, one provisional (unwrapped) passkey and one record. */
const seedPasskeyVault = async (userId: string) => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
       VALUES (?, 'passkey', NULL, 1000, 1000)`,
    ).bind(userId),
    ...[
      ['pk-wrapped', 'cred-wrapped'],
      ['pk-loose', 'cred-loose'],
    ].map(([id, credentialId]) =>
      env.DB.prepare(
        `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
         VALUES (?, ?, 'pub', ?, ?, 0, 'platform', 1, 1000)`,
      ).bind(id, id, userId, credentialId),
    ),
    env.DB.prepare(
      `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
       VALUES (?, 'pk-wrapped', 'wrap-of-the-dek', 1000, 1000)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
       VALUES (?, 'rec-1', 'address', 'Y2lwaGVy', 1000, 1)`,
    ).bind(userId),
  ]);
};

/** Everything an account-scoped request could change for one user, and the passkey challenges. */
const rowsOf = async (userId: string) => {
  const rows = async (sql: string) => (await env.DB.prepare(sql).bind(userId).all()).results;
  return {
    sessions: await rows('SELECT id FROM session WHERE userId = ? ORDER BY id'),
    challenges: (await env.DB.prepare('SELECT identifier FROM verification ORDER BY id').all())
      .results,
    account: await rows('SELECT * FROM vault_account WHERE user_id = ?'),
    wraps: await rows('SELECT * FROM vault_passkey_wrap WHERE user_id = ?'),
    records: await rows('SELECT * FROM vault_record WHERE user_id = ?'),
    passkeys: await rows('SELECT id FROM passkey WHERE userId = ? ORDER BY id'),
    credentials: await rows(
      "SELECT id FROM account WHERE userId = ? AND providerId = 'credential'",
    ),
  };
};

/** Every vault route, and every account-scoped Better Auth path the app calls. */
const ENDPOINTS: readonly {
  readonly name: string;
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  /** What the request answers when it names the session's own account. */
  readonly accepted: number;
}[] = [
  { name: 'read the unlock status', path: '/api/v1/vault/unlock', method: 'GET', accepted: 200 },
  {
    name: 'read a passkey wrap',
    path: '/api/v1/vault/unlock/passkey/cred-wrapped',
    method: 'GET',
    accepted: 200,
  },
  {
    name: 'switch to a password, deleting every passkey',
    path: '/api/v1/vault/unlock',
    method: 'PUT',
    body: { mode: 'password', isNewVault: false, wrappedDek: 'bmV3LXdyYXA', authValue: AUTH_VALUE },
    accepted: 200,
  },
  {
    name: 'wrap the key under a passkey',
    path: '/api/v1/vault/unlock',
    method: 'PUT',
    body: { mode: 'passkey', isNewVault: false, credentialId: 'cred-loose', wrappedDek: 'bmV3' },
    accepted: 200,
  },
  { name: 'reset the vault', path: '/api/v1/vault', method: 'DELETE', accepted: 200 },
  {
    name: 'read a record',
    path: '/api/v1/vault/records/address/rec-1',
    method: 'GET',
    accepted: 200,
  },
  {
    name: 'list records',
    path: '/api/v1/vault/records/address',
    method: 'GET',
    accepted: 200,
  },
  {
    name: 'write a record',
    path: '/api/v1/vault/records/address/rec-2',
    method: 'PUT',
    body: { ciphertext: 'b3RoZXI', revision: 1 },
    accepted: 200,
  },
  {
    name: 'delete a record',
    path: '/api/v1/vault/records/address/rec-1',
    method: 'DELETE',
    accepted: 200,
  },
  {
    name: 'delete a provisional passkey',
    path: '/api/auth/passkey/delete-passkey',
    method: 'POST',
    body: { id: 'pk-loose' },
    accepted: 200,
  },
  {
    name: 'ask for passkey registration options',
    path: '/api/auth/passkey/generate-register-options',
    method: 'GET',
    accepted: 200,
  },
  {
    name: 'register a passkey',
    path: '/api/auth/passkey/verify-registration',
    method: 'POST',
    body: { response: {} },
    // No ceremony was started, so Better Auth refuses it for want of a challenge, past our policy.
    accepted: 400,
  },
  { name: 'sign out', path: '/api/auth/sign-out', method: 'POST', body: {}, accepted: 200 },
];

/** Our routes answer `{ error: { code } }`; Better Auth's `{ code }`. */
const codeOf = async (response: Response): Promise<string | undefined> => {
  const body = await response.json<{ error?: { code?: string }; code?: string }>();
  return body.error?.code ?? body.code;
};

describe('An account-scoped request', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  const request = (
    { path, method, body }: (typeof ENDPOINTS)[number],
    { cookie, account }: { readonly cookie: string; readonly account?: string },
  ) =>
    createApp().request(
      `http://localhost${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: 'https://yozz.app',
          ...(account === undefined ? {} : { [ACCOUNT_HEADER]: account }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  it.each(ENDPOINTS)('cannot $name in the account of whoever signed in since', async endpoint => {
    const alice = await signIn('alice@example.com');
    // Another tab of the same browser: the cookie is Bob's now, the request was made for Alice.
    const bob = await signIn('bob@example.com');
    await seedPasskeyVault(bob.userId);
    const before = await rowsOf(bob.userId);

    const response = await request(endpoint, { cookie: bob.cookie, account: alice.userId });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('ACCOUNT_MISMATCH');
    expect(await rowsOf(bob.userId)).toEqual(before);
  });

  it.each(ENDPOINTS)('cannot $name without naming the account', async endpoint => {
    const bob = await signIn('bob@example.com');
    await seedPasskeyVault(bob.userId);
    const before = await rowsOf(bob.userId);

    for (const account of [undefined, '']) {
      const response = await request(endpoint, { cookie: bob.cookie, account });

      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe('ACCOUNT_MISMATCH');
    }
    expect(await rowsOf(bob.userId)).toEqual(before);
  });

  it.each(ENDPOINTS)('can $name in the account it names', async endpoint => {
    const bob = await signIn('bob@example.com');
    await seedPasskeyVault(bob.userId);

    const response = await request(endpoint, { cookie: bob.cookie, account: bob.userId });

    expect(response.status).toBe(endpoint.accepted);
  });

  it('lets the web app name its account across origins', async () => {
    const preflight = await createApp().request(
      'http://localhost/api/v1/vault/unlock',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://yozz.app',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': `content-type, ${ACCOUNT_HEADER.toLowerCase()}`,
        },
      },
      env,
    );
    expect(preflight.headers.get('access-control-allow-headers')).toContain(ACCOUNT_HEADER);
  });
});
