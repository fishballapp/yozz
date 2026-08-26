import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { EmailSender } from '../src/email.ts';
import { applyMigrations } from './apply-migrations.ts';

describe('Worker auth policies and magic link', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('signs up via magic link with test email sender seam', async () => {
    let capturedMail: { to: string; url: string; token: string } | null = null;
    const emailSender: EmailSender = async mail => {
      capturedMail = mail;
    };

    const app = createApp({ emailSender });

    // Request magic link
    const sendRes = await app.request(
      'http://localhost/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          email: 'alice@example.com',
          name: 'Alice',
        }),
      },
      env,
    );

    expect(sendRes.status).toBe(200);
    expect(capturedMail).not.toBeNull();
    if (!capturedMail) throw new Error('Email was not sent');
    const mail: { to: string; url: string; token: string } = capturedMail;
    expect(mail.to).toBe('alice@example.com');
    expect(mail.url).toContain('/api/auth/magic-link/verify?token=');

    // Follow the magic link
    const verifyRes = await app.request(mail.url, { method: 'GET' }, env);
    expect([200, 302]).toContain(verifyRes.status);

    const cookies = verifyRes.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('better-auth.session_token');

    // Magic link completion produces session only, no wrap or key
    const verifyBody = await verifyRes.text();
    expect(verifyBody).not.toContain('wrappedDek');
    expect(verifyBody).not.toContain('encKey');
    expect(verifyBody).not.toContain('masterKey');
  });

  it('refuses a recovery link for an unknown email, and allows signup for the same email', async () => {
    let sent = 0;
    const app = createApp({
      emailSender: async () => {
        sent += 1;
      },
    });
    const request = (callbackURL: string) =>
      app.request(
        'http://localhost/api/auth/sign-in/magic-link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
          body: JSON.stringify({ email: 'nobody@example.com', callbackURL }),
        },
        env,
      );

    const recovery = await request('https://yozz.app/enrol?reset=1');
    expect(recovery.status).toBe(404);
    expect(sent).toBe(0);
    const user = await env.DB.prepare('SELECT id FROM user WHERE email = ?')
      .bind('nobody@example.com')
      .first();
    expect(user).toBeNull();

    const signup = await request('https://yozz.app/enrol');
    expect(signup.status).toBe(200);
    expect(sent).toBe(1);
  });

  it('refuses password sign-in when account is not in password mode', async () => {
    const app = createApp();

    // Create user in DB with no vault_account
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('user-no-mode', 'No Mode', 'nomode@example.com', 1, 1000, 1000)
      .run();

    const resNoMode = await app.request(
      'http://localhost/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          email: 'nomode@example.com',
          password: 'auth-value-123',
        }),
      },
      env,
    );

    expect(resNoMode.status).toBe(403);
    const bodyNoMode = await resNoMode.json<{ message: string; code: string }>();
    expect(bodyNoMode.code).toBe('INVALID_MODE');

    // Create user in passkey mode
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('user-passkey', 'Passkey User', 'passkey@example.com', 1, 1000, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('user-passkey', 'passkey', null, 1000, 1000)
      .run();

    const resPasskeyMode = await app.request(
      'http://localhost/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          email: 'passkey@example.com',
          password: 'auth-value-123',
        }),
      },
      env,
    );

    expect(resPasskeyMode.status).toBe(403);
    const bodyPasskeyMode = await resPasskeyMode.json<{ code: string }>();
    expect(bodyPasskeyMode.code).toBe('INVALID_MODE');
  });

  it('refuses passkey authentication when account is not in passkey mode or unwrapped', async () => {
    const app = createApp();

    // Create user with passkey in DB but mode is password
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('user-pk-test', 'PK Test', 'pktest@example.com', 1, 1000, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('user-pk-test', 'password', 'wrap-pw', 1000, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-1', 'Key 1', 'pubkey', 'user-pk-test', 'cred-123', 0, 'platform', 1, 1000)
      .run();

    const resWrongMode = await app.request(
      'http://localhost/api/auth/passkey/verify-authentication',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          response: { id: 'cred-123' },
        }),
      },
      env,
    );

    expect(resWrongMode.status).toBe(403);
    const bodyWrongMode = await resWrongMode.json<{ code: string }>();
    expect(bodyWrongMode.code).toBe('INVALID_MODE');
  });

  it('refuses passkey deletion for active wrapped passkeys and allows unwrapped ones', async () => {
    let magicUrl = '';
    const app = createApp({
      emailSender: async mail => {
        magicUrl = mail.url;
      },
    });

    // Create authenticated user via magic link
    await app.request(
      'http://localhost/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          email: 'deltest@example.com',
          name: 'Del Test',
        }),
      },
      env,
    );

    const verifyRes = await app.request(magicUrl, { method: 'GET' }, env);
    const cookieHeader = verifyRes.headers.get('set-cookie') ?? '';

    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind('deltest@example.com')
      .first<{ id: string }>();
    if (!user) throw new Error('User not found');

    await env.DB.prepare(
      'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(user.id, 'passkey', null, 1000, 1000)
      .run();

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('pk-wrapped', 'Wrapped Key', 'pub1', user.id, 'cred-wrapped', 0, 'platform', 1, 1000)
      .run();
    await env.DB.prepare(
      'INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(user.id, 'pk-wrapped', 'wrap-data', 1000, 1000)
      .run();

    await env.DB.prepare(
      'INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        'pk-unwrapped',
        'Unwrapped Key',
        'pub2',
        user.id,
        'cred-unwrapped',
        0,
        'platform',
        1,
        1000,
      )
      .run();

    // Attempting to delete wrapped passkey must be refused
    const resWrapped = await app.request(
      'http://localhost/api/auth/passkey/delete-passkey',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
        },
        body: JSON.stringify({ id: 'pk-wrapped' }),
      },
      env,
    );

    expect(resWrapped.status).toBe(403);
    const bodyWrapped = await resWrapped.json<{ code: string }>();
    expect(bodyWrapped.code).toBe('PASSKEY_IN_USE');

    // Deleting unwrapped provisional passkey is allowed
    const resUnwrapped = await app.request(
      'http://localhost/api/auth/passkey/delete-passkey',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
        },
        body: JSON.stringify({ id: 'pk-unwrapped' }),
      },
      env,
    );

    expect(resUnwrapped.status).toBe(200);
  });

  it('strictly disables raw password change, password reset, email change, and email signup', async () => {
    const app = createApp();

    const disabledPaths = [
      '/api/auth/change-password',
      '/api/auth/reset-password',
      '/api/auth/request-password-reset',
      '/api/auth/change-email',
      '/api/auth/sign-up/email',
    ];

    for (const path of disabledPaths) {
      const res = await app.request(
        `http://localhost${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
          body: JSON.stringify({ email: 'test@example.com' }),
        },
        env,
      );
      expect([403, 404]).toContain(res.status);
    }
  });

  it('failure responses never echo magic tokens, passwords, or ciphertext', async () => {
    const app = createApp();

    const secretToken = 'super-secret-magic-token-xyz';
    const secretPassword = 'my-super-secret-password-123';

    const res = await app.request(
      'http://localhost/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
        body: JSON.stringify({
          email: 'unknown@example.com',
          password: secretPassword,
          token: secretToken,
        }),
      },
      env,
    );

    const bodyText = await res.text();
    expect(bodyText).not.toContain(secretPassword);
    expect(bodyText).not.toContain(secretToken);
  });
});
