import { env } from 'cloudflare:test';
import { ACCOUNT_HEADER, WEBAUTHN_TIMEOUT_MS } from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { EmailSender } from '../src/email.ts';
import { applyMigrations } from './apply-migrations.ts';

describe('Worker auth policies and magic link', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  /** A magic-link sign-in, returning the app, the session cookie it set and whose session it is. */
  const signedIn = async (email: string) => {
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
    const verifyRes = await app.request(magicUrl, { method: 'GET' }, env);
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();
    if (!user) throw new Error(`User not found for ${email}`);
    return { app, cookieHeader: verifyRes.headers.get('set-cookie') ?? '', userId: user.id };
  };

  it('signs up via magic link with test email sender seam', async () => {
    let capturedMail: { to: string; url: string; token: string } | null = null;
    const emailSender: EmailSender = async mail => {
      capturedMail = mail;
    };

    const app = createApp({ emailSender });

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

    const verifyRes = await app.request(mail.url, { method: 'GET' }, env);
    expect([200, 302]).toContain(verifyRes.status);

    const cookies = verifyRes.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('better-auth.session_token');

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

  it('gives every passkey prompt five minutes, and never mints a session from registration', async () => {
    const { app, cookieHeader, userId } = await signedIn('fresh@example.com');

    const register = await app.request(
      'http://localhost/api/auth/passkey/generate-register-options',
      { headers: { Cookie: cookieHeader, Origin: 'https://yozz.app', [ACCOUNT_HEADER]: userId } },
      env,
    );
    expect(register.status).toBe(200);
    const registerOptions = await register.json<{ challenge: string; timeout: number }>();
    expect(registerOptions.challenge).toBeTruthy();
    expect(registerOptions.timeout).toBe(WEBAUTHN_TIMEOUT_MS);
    // The hook replaces the body; the plugin's challenge cookie must survive it.
    expect(register.headers.get('set-cookie')).toContain('better-auth-passkey');

    const authenticate = await app.request(
      'http://localhost/api/auth/passkey/generate-authenticate-options',
      { headers: { Origin: 'https://yozz.app' } },
      env,
    );
    expect(authenticate.status).toBe(200);
    const authOptions = await authenticate.json<{ challenge: string; timeout: number }>();
    expect(authOptions.challenge).toBeTruthy();
    expect(authOptions.timeout).toBe(WEBAUTHN_TIMEOUT_MS);

    // A second session that outlives the first is persistence for whoever holds the first.
    const minted = await app.request(
      'http://localhost/api/auth/passkey/verify-registration',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
          [ACCOUNT_HEADER]: userId,
        },
        body: JSON.stringify({ response: {}, createSession: true }),
      },
      env,
    );
    expect(minted.status).toBe(400);
    // Refused by our policy before Better Auth reads the (empty) attestation at all.
    expect(await minted.json()).toMatchObject({
      message: 'Adding a passkey never creates a session',
    });
  });

  it('refuses a day-old session every change to how the vault opens', async () => {
    const { app, cookieHeader, userId } = await signedIn('stale@example.com');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await env.DB.prepare('UPDATE session SET createdAt = ?').bind(twoDaysAgo.toISOString()).run();
    const headers = {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      Origin: 'https://yozz.app',
      [ACCOUNT_HEADER]: userId,
    };

    const register = await app.request(
      'http://localhost/api/auth/passkey/generate-register-options',
      { headers },
      env,
    );
    expect(register.status).toBe(403);

    // A stolen cookie on a passkey account could otherwise set a password of its own.
    const switched = await app.request(
      'http://localhost/api/v1/vault/unlock',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          mode: 'password',
          isNewVault: false,
          wrappedDek: 'd3JhcA',
          authValue: 'a'.repeat(64),
        }),
      },
      env,
    );
    expect(switched.status).toBe(403);
    expect(await switched.json()).toMatchObject({ error: { code: 'SESSION_NOT_FRESH' } });

    const reset = await app.request(
      'http://localhost/api/v1/vault',
      { method: 'DELETE', headers },
      env,
    );
    expect(reset.status).toBe(403);
    expect(await reset.json()).toMatchObject({ error: { code: 'SESSION_NOT_FRESH' } });
  });

  it('refuses passkey deletion for active wrapped passkeys and allows unwrapped ones', async () => {
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

    const resWrapped = await app.request(
      'http://localhost/api/auth/passkey/delete-passkey',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
          [ACCOUNT_HEADER]: user.id,
        },
        body: JSON.stringify({ id: 'pk-wrapped' }),
      },
      env,
    );

    expect(resWrapped.status).toBe(403);
    const bodyWrapped = await resWrapped.json<{ code: string }>();
    expect(bodyWrapped.code).toBe('PASSKEY_IN_USE');

    const resUnwrapped = await app.request(
      'http://localhost/api/auth/passkey/delete-passkey',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
          [ACCOUNT_HEADER]: user.id,
        },
        body: JSON.stringify({ id: 'pk-unwrapped' }),
      },
      env,
    );

    expect(resUnwrapped.status).toBe(200);
  });

  /**
   * Every path Better Auth 1.7.5 mounts with these plugins that the app does not call. A password,
   * email or signup route would change an unlock credential without re-wrapping the DEK; the rest
   * would act on whichever account holds the cookie.
   */
  const UNCALLED_PATHS: readonly (readonly ['GET' | 'POST', string])[] = [
    ['POST', '/sign-up/email'],
    ['POST', '/change-password'],
    ['POST', '/request-password-reset'],
    ['POST', '/reset-password'],
    ['GET', '/reset-password/some-token'],
    ['POST', '/change-email'],
    ['POST', '/update-user'],
    ['POST', '/update-session'],
    ['POST', '/delete-user'],
    ['GET', '/delete-user/callback'],
    ['GET', '/list-sessions'],
    ['POST', '/revoke-session'],
    ['POST', '/revoke-sessions'],
    ['POST', '/revoke-other-sessions'],
    ['GET', '/list-accounts'],
    ['GET', '/account-info'],
    ['POST', '/link-social'],
    ['POST', '/unlink-account'],
    ['POST', '/refresh-token'],
    ['POST', '/get-access-token'],
    ['POST', '/sign-in/social'],
    ['GET', '/callback/google'],
    ['POST', '/send-verification-email'],
    ['GET', '/verify-email'],
    ['POST', '/verify-password'],
    ['GET', '/passkey/list-user-passkeys'],
    ['POST', '/passkey/update-passkey'],
    ['GET', '/ok'],
    ['GET', '/error'],
  ];

  it.each(UNCALLED_PATHS)('refuses %s %s, which the app never calls', async (method, path) => {
    const { app, cookieHeader, userId } = await signedIn('uncalled@example.com');
    const before = await env.DB.prepare('SELECT * FROM "user" WHERE id = ?').bind(userId).first();

    const res = await app.request(
      `http://localhost/api/auth${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Origin: 'https://yozz.app',
          [ACCOUNT_HEADER]: userId,
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ name: 'Renamed', email: 'other@example.com' }) }
          : {}),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(await env.DB.prepare('SELECT * FROM "user" WHERE id = ?').bind(userId).first()).toEqual(
      before,
    );
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
