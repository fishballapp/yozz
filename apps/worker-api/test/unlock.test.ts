import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { applyMigrations } from './apply-migrations.ts';

/** base64 of 32 bytes, the shape of `authValue`. */
const AUTH_VALUE = 'q0dGZ0Z0RGZnZGZnZGZnZGZnZGZnZGZnZGZnZGZnZGY=';

describe('Worker unlock and finalisation routes', () => {
  const loginWithMagicLink = async (
    email: string,
    name = 'Unlock User',
  ): Promise<{ userId: string; headers: Record<string, string> }> => {
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
        body: JSON.stringify({ email, name }),
      },
      env,
    );

    const verifyRes = await app.request(magicUrl, { method: 'GET' }, env);
    const cookieHeader = verifyRes.headers.get('set-cookie') ?? '';

    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();

    if (!user) throw new Error(`User not found for ${email}`);

    return {
      userId: user.id,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        Origin: 'https://yozz.app',
      },
    };
  };

  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('GET /api/v1/vault/unlock returns mode: null initially', async () => {
    const { headers } = await loginWithMagicLink('unlock1@example.com');
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/v1/vault/unlock',
      { method: 'GET', headers },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ mode: unknown }>();
    expect(body).toEqual({ mode: null });
  });

  it('PUT /api/v1/vault/unlock finalises password mode and cleans up passkeys', async () => {
    const { userId, headers } = await loginWithMagicLink('unlock2@example.com');
    const app = createApp();

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-old', 'Old PK', 'pub', userId, 'cred-old', 0, 'platform', 1, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(userId, 'pk-old', 'wrap-old', 1000, 1000)
      .run();

    const res = await app.request(
      'http://localhost/api/v1/vault/unlock',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          mode: 'password',
          isNewVault: true,
          wrappedDek: 'pw-wrapped-dek-123',
          authValue: AUTH_VALUE,
        }),
      },
      env,
    );

    expect(res.status).toBe(200);

    // The credential row must exist: mode and wrap alone cannot see a finalisation that never created it.
    const credential = await env.DB.prepare(
      "SELECT id FROM account WHERE userId = ? AND providerId = 'credential'",
    )
      .bind(userId)
      .first<{ id: string }>();
    expect(credential).not.toBeNull();

    const account = await env.DB.prepare(
      'SELECT unlock_mode, password_wrapped_dek FROM vault_account WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ unlock_mode: string; password_wrapped_dek: string }>();

    expect(account?.unlock_mode).toBe('password');
    expect(account?.password_wrapped_dek).toBe('pw-wrapped-dek-123');

    const wraps = await env.DB.prepare('SELECT * FROM vault_passkey_wrap WHERE user_id = ?')
      .bind(userId)
      .all();
    expect(wraps.results).toHaveLength(0);

    const passkeys = await env.DB.prepare('SELECT * FROM passkey WHERE userId = ?')
      .bind(userId)
      .all();
    expect(passkeys.results).toHaveLength(0);
  });

  it('PUT /api/v1/vault/unlock finalises passkey mode, purges password credential, and supports multiple authenticators', async () => {
    const { userId, headers } = await loginWithMagicLink('unlock3@example.com');
    const app = createApp();

    await env.DB.prepare(
      "INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, 'local:credential', ?, ?, ?, ?, ?, ?)",
    )
      .bind('acc-cred', userId, 'credential', userId, 'hash', 1000, 1000)
      .run();

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-1', 'Key 1', 'pubkey-1', userId, 'cred-pk-1', 0, 'platform', 1, 1000)
      .run();

    const res1 = await app.request(
      'http://localhost/api/v1/vault/unlock',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          mode: 'passkey',
          isNewVault: true,
          credentialId: 'cred-pk-1',
          wrappedDek: 'pk-wrapped-dek-1',
        }),
      },
      env,
    );

    expect(res1.status).toBe(200);

    const account1 = await env.DB.prepare(
      'SELECT unlock_mode, password_wrapped_dek FROM vault_account WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ unlock_mode: string; password_wrapped_dek: string | null }>();
    expect(account1?.unlock_mode).toBe('passkey');
    expect(account1?.password_wrapped_dek).toBeNull();

    const credAccount = await env.DB.prepare(
      "SELECT * FROM account WHERE userId = ? AND providerId = 'credential'",
    )
      .bind(userId)
      .all();
    expect(credAccount.results).toHaveLength(0);

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-2', 'Key 2', 'pubkey-2', userId, 'cred-pk-2', 0, 'platform', 1, 1000)
      .run();

    const res2 = await app.request(
      'http://localhost/api/v1/vault/unlock',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          mode: 'passkey',
          isNewVault: false,
          credentialId: 'cred-pk-2',
          wrappedDek: 'pk-wrapped-dek-2',
        }),
      },
      env,
    );
    expect(res2.status).toBe(200);

    const wraps = await env.DB.prepare(
      'SELECT passkey_id, wrapped_dek FROM vault_passkey_wrap WHERE user_id = ? ORDER BY passkey_id ASC',
    )
      .bind(userId)
      .all<{ passkey_id: string; wrapped_dek: string }>();

    expect(wraps.results).toHaveLength(2);
    expect(wraps.results[0]?.passkey_id).toBe('pk-1');
    expect(wraps.results[1]?.passkey_id).toBe('pk-2');
  });

  it('GET /api/v1/vault/unlock/passkey/:credentialId returns wrap for matching credential', async () => {
    const { userId, headers } = await loginWithMagicLink('unlock4@example.com');
    const app = createApp();

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-fetch', 'Fetch PK', 'pub', userId, 'cred-target', 0, 'platform', 1, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(userId, 'pk-fetch', 'wrapped-dek-target', 1000, 1000)
      .run();

    const res = await app.request(
      'http://localhost/api/v1/vault/unlock/passkey/cred-target',
      { method: 'GET', headers },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ wrappedDek: string }>();
    expect(body.wrappedDek).toBe('wrapped-dek-target');

    const resNotFound = await app.request(
      'http://localhost/api/v1/vault/unlock/passkey/unknown-cred',
      { method: 'GET', headers },
      env,
    );
    expect(resNotFound.status).toBe(404);
  });

  it('DELETE /api/v1/vault performs recovery reset, retaining user and session', async () => {
    const { userId, headers } = await loginWithMagicLink('unlock5@example.com');
    const app = createApp();

    await env.DB.prepare(
      'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(userId, 'password', 'wrap-to-delete', 1000, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(userId, 'rec-1', 'account', 'cipher-1', 1000)
      .run();

    const res = await app.request(
      'http://localhost/api/v1/vault',
      { method: 'DELETE', headers },
      env,
    );

    expect(res.status).toBe(200);

    const account = await env.DB.prepare('SELECT * FROM vault_account WHERE user_id = ?')
      .bind(userId)
      .all();
    expect(account.results).toHaveLength(0);

    const records = await env.DB.prepare('SELECT * FROM vault_record WHERE user_id = ?')
      .bind(userId)
      .all();
    expect(records.results).toHaveLength(0);

    const user = await env.DB.prepare('SELECT id FROM "user" WHERE id = ?')
      .bind(userId)
      .first<{ id: string }>();
    expect(user?.id).toBe(userId);

    const sessions = await env.DB.prepare('SELECT id FROM session WHERE userId = ?')
      .bind(userId)
      .all();
    expect(sessions.results.length).toBeGreaterThan(0);
  });

  it('PUT /api/v1/vault/unlock with isNewVault refuses a second creator, atomically', async () => {
    // Two tabs can both read `mode: null` and both mint a DEK; exactly one INSERT commits.
    const { userId, headers } = await loginWithMagicLink('race@example.com');
    const app = createApp();
    for (const [id, cred] of [
      ['pk-a', 'cred-a'],
      ['pk-b', 'cred-b'],
    ]) {
      await env.DB.prepare(
        'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, id, 'pub', userId, cred, 0, 'platform', 1, 1000)
        .run();
    }

    const finalise = (credentialId: string, isNewVault: boolean) =>
      app.request(
        'http://localhost/api/v1/vault/unlock',
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            mode: 'passkey',
            isNewVault,
            credentialId,
            wrappedDek: `dek-${credentialId}`,
          }),
        },
        env,
      );

    expect((await finalise('cred-a', true)).status).toBe(200);
    const second = await finalise('cred-b', true);
    expect(second.status).toBe(409);
    expect((await second.json<{ error: { code: string } }>()).error.code).toBe('CONFLICT');

    const wraps = await env.DB.prepare(
      'SELECT passkey_id FROM vault_passkey_wrap WHERE user_id = ?',
    )
      .bind(userId)
      .all<{ passkey_id: string }>();
    expect(wraps.results.map(r => r.passkey_id)).toEqual(['pk-a']);

    expect((await finalise('cred-b', false)).status).toBe(200);
  });
});
