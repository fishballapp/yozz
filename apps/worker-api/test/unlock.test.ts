import { env } from 'cloudflare:test';
import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { changePasswordUnlock, finalizePasswordUnlock } from '../src/db/unlock.ts';
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
        [ACCOUNT_HEADER]: user.id,
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

  describe('a password account', () => {
    const NEW_AUTH_VALUE = 'bmV3LXBhc3N3b3JkLWF1dGgtdmFsdWUtMzJieXRlcyE=';
    const UNLOCK = 'http://localhost/api/v1/vault/unlock';

    const put = (headers: Record<string, string>, path: string, body: Record<string, unknown>) =>
      createApp().request(
        `${UNLOCK}${path}`,
        { method: 'PUT', headers, body: JSON.stringify(body) },
        env,
      );

    const signIn = (email: string, authValue: string) =>
      createApp().request(
        'http://localhost/api/auth/sign-in/email',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
          body: JSON.stringify({ email, password: authValue }),
        },
        env,
      );

    const change = (headers: Record<string, string>, overrides: Record<string, unknown> = {}) =>
      put(headers, '/password', {
        currentAuthValue: AUTH_VALUE,
        newAuthValue: NEW_AUTH_VALUE,
        wrappedDek: 'dek-2',
        ...overrides,
      });

    /** A password account whose wrapped DEK is `dek-1`, plus a second device signed in. */
    const passwordAccount = async (email: string) => {
      const device = await loginWithMagicLink(email);
      const otherDevice = await loginWithMagicLink(email);
      const created = await put(device.headers, '', {
        mode: 'password',
        isNewVault: true,
        wrappedDek: 'dek-1',
        authValue: AUTH_VALUE,
      });
      expect(created.status).toBe(200);
      return { ...device, email, otherDevice };
    };

    /** Everything a half-applied change could leave behind. */
    const stored = async (userId: string) => ({
      wrap: (
        await env.DB.prepare('SELECT password_wrapped_dek FROM vault_account WHERE user_id = ?')
          .bind(userId)
          .first<{ password_wrapped_dek: string }>()
      )?.password_wrapped_dek,
      hash: (
        await env.DB.prepare(
          "SELECT password FROM account WHERE userId = ? AND providerId = 'credential'",
        )
          .bind(userId)
          .first<{ password: string }>()
      )?.password,
      sessions: (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?')
          .bind(userId)
          .first<{ n: number }>()
      )?.n,
    });

    const sessionIdOf = async (userId: string) =>
      (
        await env.DB.prepare('SELECT id FROM session WHERE userId = ? LIMIT 1')
          .bind(userId)
          .first<{ id: string }>()
      )?.id ?? '';

    const makeStale = (userId: string) =>
      env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?')
        .bind(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), userId)
        .run();

    it('changes the password and the wrapped DEK together, and the new password signs in', async () => {
      const account = await passwordAccount('change-ok@example.com');

      const res = await change(account.headers);
      expect(res.status).toBe(200);

      const after = await stored(account.userId);
      expect(after.wrap).toBe('dek-2');
      // The old authValue no longer opens the account; the new one does.
      expect((await signIn(account.email, AUTH_VALUE)).status).toBe(401);
      expect((await signIn(account.email, NEW_AUTH_VALUE)).status).toBe(200);
      // What a device resuming compares: it moves, so persisted keys for the old wrap are dropped.
      const status = await createApp().request(UNLOCK, { headers: account.headers }, env);
      expect(await status.json<{ wrappedDek: string }>()).toMatchObject({ wrappedDek: 'dek-2' });
    });

    it('signs every other device out and keeps the one that changed it', async () => {
      const account = await passwordAccount('change-sessions@example.com');

      expect((await change(account.headers)).status).toBe(200);

      const get = (headers: Record<string, string>) =>
        createApp().request(UNLOCK, { headers }, env);
      expect((await get(account.headers)).status).toBe(200);
      expect((await get(account.otherDevice.headers)).status).toBe(401);
    });

    it('refuses a wrong current password and changes nothing', async () => {
      const account = await passwordAccount('change-wrong@example.com');
      const before = await stored(account.userId);

      const res = await change(account.headers, { currentAuthValue: NEW_AUTH_VALUE });

      expect(res.status).toBe(403);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('WRONG_PASSWORD');
      expect(await stored(account.userId)).toEqual(before);
      expect((await signIn(account.email, AUTH_VALUE)).status).toBe(200);
    });

    it('refuses a session older than a day, however right the current password is', async () => {
      const account = await passwordAccount('change-stale@example.com');
      await makeStale(account.userId);
      const before = await stored(account.userId);

      const res = await change(account.headers);

      expect(res.status).toBe(403);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('SESSION_NOT_FRESH');
      expect(await stored(account.userId)).toEqual(before);
    });

    it('refuses a payload that is not exactly the three fields', async () => {
      const account = await passwordAccount('change-shape@example.com');
      const before = await stored(account.userId);

      expect((await change(account.headers, { newAuthValue: 'short' })).status).toBe(400);
      expect((await change(account.headers, { extra: true })).status).toBe(400);
      expect(await stored(account.userId)).toEqual(before);
    });

    it('answers a passkey account that it has no password to change', async () => {
      const { userId, headers } = await loginWithMagicLink('change-passkey@example.com');
      await env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
      )
        .bind(userId, 'passkey', 1000, 1000)
        .run();

      const res = await change(headers);

      expect(res.status).toBe(403);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('INVALID_MODE');
    });

    it('leaves the old credential, the old wrapped DEK and every session when the change fails halfway', async () => {
      const account = await passwordAccount('change-half@example.com');
      const before = await stored(account.userId);
      // The credential is written after the wrap and before the sessions go: failing there means
      // a change without one batch has already moved the wrap, or has not yet signed anyone out.
      await env.DB.exec(
        "CREATE TRIGGER fail_credential_write BEFORE UPDATE OF password ON account BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );

      const res = await change(account.headers);

      expect(res.status).toBe(500);
      expect(await stored(account.userId)).toEqual(before);
    });

    it('applies nothing when another change got there first', async () => {
      const account = await passwordAccount('change-race@example.com');
      const before = await stored(account.userId);

      const isChanged = await changePasswordUnlock(env.DB, account.userId, {
        currentHash: 'a hash this account no longer holds',
        newHash: 'new-hash',
        wrappedDek: 'dek-2',
        keepSessionId: await sessionIdOf(account.userId),
        now: Date.now(),
      });

      expect(isChanged).toBe(false);
      expect(await stored(account.userId)).toEqual(before);
    });

    /** A passkey account: one passkey, wrapped, and no credential. */
    const passkeyAccount = async (email: string) => {
      const device = await loginWithMagicLink(email);
      await env.DB.exec(
        `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES ('pk-1', 'Key', 'pub', '${device.userId}', 'cred-1', 0, 'platform', 1, 1000);
         INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES ('${device.userId}', 'passkey', NULL, 1000, 1000);
         INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES ('${device.userId}', 'pk-1', 'pk-dek', 1000, 1000)`,
      );
      return { ...device, email };
    };

    const switchBody = {
      mode: 'password',
      isNewVault: false,
      wrappedDek: 'dek-pw',
      authValue: AUTH_VALUE,
    };

    it('switches a passkey account to a password that signs in, with its passkeys gone', async () => {
      const account = await passkeyAccount('switch-ok@example.com');

      expect((await put(account.headers, '', switchBody)).status).toBe(200);

      expect((await signIn(account.email, AUTH_VALUE)).status).toBe(200);
      expect((await stored(account.userId)).wrap).toBe('dek-pw');
      const passkeys = await env.DB.prepare('SELECT id FROM passkey WHERE userId = ?')
        .bind(account.userId)
        .all();
      expect(passkeys.results).toHaveLength(0);
    });

    it('leaves the passkeys and their wrap when the switch fails halfway', async () => {
      const account = await passkeyAccount('switch-half@example.com');
      // The credential is the last write: a switch that is not one batch has moved everything else.
      await env.DB.exec(
        "CREATE TRIGGER fail_credential_insert BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );

      const res = await put(account.headers, '', switchBody);

      expect(res.status).toBe(500);
      const mode = await env.DB.prepare('SELECT unlock_mode FROM vault_account WHERE user_id = ?')
        .bind(account.userId)
        .first<{ unlock_mode: string }>();
      expect(mode?.unlock_mode).toBe('passkey');
      const wraps = await env.DB.prepare(
        'SELECT passkey_id FROM vault_passkey_wrap WHERE user_id = ?',
      )
        .bind(account.userId)
        .all();
      expect(wraps.results).toHaveLength(1);
      const passkeys = await env.DB.prepare('SELECT id FROM passkey WHERE userId = ?')
        .bind(account.userId)
        .all();
      expect(passkeys.results).toHaveLength(1);
    });

    it('finishes a vault whose credential an earlier half-done switch left behind', async () => {
      const { userId, email, headers } = {
        ...(await loginWithMagicLink('switch-orphan@example.com')),
        email: 'switch-orphan@example.com',
      };
      await env.DB.prepare(
        "INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('orphan', ?, 'credential', ?, 'stale:hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      )
        .bind(userId, userId)
        .run();

      const res = await put(headers, '', { ...switchBody, isNewVault: true });

      expect(res.status).toBe(200);
      expect((await signIn(email, AUTH_VALUE)).status).toBe(200);
    });

    /** The vault as a switch leaves it, whatever it was: the wrap, the credential count and the passkeys. */
    const vaultOf = async (userId: string) => ({
      mode: (
        await env.DB.prepare('SELECT unlock_mode FROM vault_account WHERE user_id = ?')
          .bind(userId)
          .first<{ unlock_mode: string }>()
      )?.unlock_mode,
      ...(await stored(userId)),
      credentials: (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM account WHERE userId = ? AND providerId = 'credential'",
        )
          .bind(userId)
          .first<{ n: number }>()
      )?.n,
      passkeys: (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?')
          .bind(userId)
          .first<{ n: number }>()
      )?.n,
    });

    const switchTo = (
      userId: string,
      sessionId: string,
      wrappedDek: string,
      passwordHash: string,
    ) =>
      finalizePasswordUnlock(env.DB, userId, {
        isNewVault: false,
        wrappedDek,
        passwordHash,
        sessionId,
        now: Date.now(),
      });

    it('lets one of two switches through and answers the other that the account moved', async () => {
      const account = await passkeyAccount('switch-race@example.com');
      const sessionId = await sessionIdOf(account.userId);

      // The second batch runs after the first, having checked before it: the state it expected is gone.
      expect(await switchTo(account.userId, sessionId, 'dek-first', 'hash-first')).toBe(true);
      const afterFirst = await vaultOf(account.userId);
      expect(await switchTo(account.userId, sessionId, 'dek-second', 'hash-second')).toBe(false);

      expect(await vaultOf(account.userId)).toEqual(afterFirst);
      expect(afterFirst).toMatchObject({ wrap: 'dek-first', hash: 'hash-first', credentials: 1 });
    });

    it('does not let a second switch, in flight together with the first, replace the password', async () => {
      const account = await passkeyAccount('switch-flight@example.com');
      const other = 'b3RoZXItYXV0aC12YWx1ZS0zMi1ieXRlcy1sb25nISE=';

      const answers = await Promise.all([
        put(account.headers, '', switchBody),
        put(account.headers, '', { ...switchBody, wrappedDek: 'dek-other', authValue: other }),
      ]);

      expect(answers.map(res => res.status).toSorted()).toEqual([200, 409]);
      const [winner, loser] =
        answers[0]?.status === 200 ? [AUTH_VALUE, other] : [other, AUTH_VALUE];
      expect((await signIn(account.email, winner)).status).toBe(200);
      expect((await signIn(account.email, loser)).status).toBe(401);
      expect((await vaultOf(account.userId)).credentials).toBe(1);
    });

    it('writes nothing for a switch whose session was signed out while it was being made', async () => {
      const account = await passkeyAccount('switch-revoked@example.com');
      const sessionId = await sessionIdOf(account.userId);
      await env.DB.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();
      const before = await vaultOf(account.userId);

      expect(await switchTo(account.userId, sessionId, 'dek-late', 'hash-late')).toBe(false);

      expect(await vaultOf(account.userId)).toEqual(before);
      expect(before).toMatchObject({ mode: 'passkey', credentials: 0, passkeys: 1 });
    });

    it('writes no new vault either for a session that is gone', async () => {
      const { userId } = await loginWithMagicLink('switch-revoked-new@example.com');
      const sessionId = await sessionIdOf(userId);
      await env.DB.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();

      expect(
        await finalizePasswordUnlock(env.DB, userId, {
          isNewVault: true,
          wrappedDek: 'dek-late',
          passwordHash: 'hash-late',
          sessionId,
          now: Date.now(),
        }),
      ).toBe(false);

      expect((await vaultOf(userId)).mode).toBeUndefined();
    });

    it('applies no password change for a session that was signed out while it was being made', async () => {
      const account = await passwordAccount('change-revoked@example.com');
      const sessionId = await sessionIdOf(account.userId);
      const hash = (await stored(account.userId)).hash ?? '';
      await env.DB.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();
      const before = await vaultOf(account.userId);

      const isChanged = await changePasswordUnlock(env.DB, account.userId, {
        currentHash: hash,
        newHash: 'new-hash',
        wrappedDek: 'dek-late',
        keepSessionId: sessionId,
        now: Date.now(),
      });

      expect(isChanged).toBe(false);
      expect(await vaultOf(account.userId)).toEqual(before);
    });

    it('cannot vouch for its own switch with the wrap it read back, on an account that has a password', async () => {
      const account = await passwordAccount('switch-replay@example.com');
      const status = await createApp().request(UNLOCK, { headers: account.headers }, env);
      const { wrappedDek } = await status.json<{ wrappedDek: string }>();
      const before = await vaultOf(account.userId);

      const res = await put(account.headers, '', {
        mode: 'password',
        isNewVault: false,
        wrappedDek,
        authValue: NEW_AUTH_VALUE,
      });

      expect(res.status).toBe(409);
      expect(await vaultOf(account.userId)).toEqual(before);
      expect((await signIn(account.email, AUTH_VALUE)).status).toBe(200);
      expect((await signIn(account.email, NEW_AUTH_VALUE)).status).toBe(401);
    });

    it('cannot do it from a session that was signed out either', async () => {
      const account = await passwordAccount('switch-replay-revoked@example.com');
      const sessionId = await sessionIdOf(account.userId);
      const { wrap } = await stored(account.userId);
      await env.DB.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();
      const before = await vaultOf(account.userId);

      expect(await switchTo(account.userId, sessionId, wrap ?? '', 'attacker-hash')).toBe(false);

      expect(await vaultOf(account.userId)).toEqual(before);
      expect(before.credentials).toBe(1);
    });

    it('refuses to replace the password through the switch route, which asks for no current one', async () => {
      const account = await passwordAccount('switch-over@example.com');
      const before = await stored(account.userId);

      const res = await put(account.headers, '', {
        mode: 'password',
        isNewVault: false,
        wrappedDek: 'dek-2',
        authValue: NEW_AUTH_VALUE,
      });

      expect(res.status).toBe(409);
      expect(await stored(account.userId)).toEqual(before);
      expect((await signIn(account.email, AUTH_VALUE)).status).toBe(200);
    });
  });

  it('PUT /api/v1/vault/unlock finalises passkey mode, purges password credential, and supports multiple authenticators', async () => {
    const { userId, headers } = await loginWithMagicLink('unlock3@example.com');
    const app = createApp();

    await env.DB.prepare(
      'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
