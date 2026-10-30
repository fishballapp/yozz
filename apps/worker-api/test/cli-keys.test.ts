import { env } from 'cloudflare:test';
import {
  createVault,
  deriveApprovalKeys,
  deriveCliKeys,
  generateCliKeyPair,
  openVault,
  rewrapDek,
  type VaultKey,
} from '@yozz.app/vault';
import {
  ACCOUNT_HEADER,
  CliKeyWrapResponseSchema,
  CreateCliKeyResponseSchema,
  ListCliKeysResponseSchema,
} from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { createCliKey } from '../src/db/cli-keys.ts';
import { changePasswordUnlock } from '../src/db/unlock.ts';
import { applyMigrations } from './apply-migrations.ts';

type Person = {
  readonly userId: string;
  readonly cookie: string;
  /** The browser's unlock key, standing in for the password or passkey that derives it. */
  readonly unlockKey: VaultKey;
  readonly wrappedDek: string;
};

/** workerd caps PBKDF2 well below the password schedule's count, so the unlock key is made directly. */
const unlockKey = async (): Promise<VaultKey> => ({
  encKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ]),
});

/** Signed in through a magic link, with a password-mode vault. */
const signUp = async (email: string): Promise<Person> => {
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

  const key = await unlockKey();
  const { wrappedDek } = await createVault(key);
  await env.DB.prepare(
    `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
     VALUES (?, 'password', ?, 1000, 1000)`,
  )
    .bind(user.id, wrappedDek)
    .run();
  return {
    userId: user.id,
    cookie: verified.headers.get('set-cookie') ?? '',
    unlockKey: key,
    wrappedDek,
  };
};

const request = (
  path: string,
  {
    method = 'GET',
    headers,
    body,
  }: { method?: string; headers: Record<string, string>; body?: unknown },
) =>
  createApp().request(
    `http://localhost${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

const asSession = ({ cookie, userId }: Person) => ({ Cookie: cookie, [ACCOUNT_HEADER]: userId });

const asCliKey = (token: string, account: string) => ({
  Authorization: `Bearer ${token}`,
  [ACCOUNT_HEADER]: account,
});

/** The approve page's part: a CLI pair, the DEK wrapped to it, `POST /cli-keys`. */
const approve = async (person: Person, name = 'build box') => {
  const cliKey = await generateCliKeyPair();
  const approval = await deriveApprovalKeys(cliKey.publicKey);
  const response = await request('/api/v1/vault/cli-keys', {
    method: 'POST',
    headers: asSession(person),
    body: {
      name,
      publicKey: cliKey.publicKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
      wrappedDek: await rewrapDek(person.unlockKey, approval, person.wrappedDek),
    },
  });
  expect(response.status).toBe(200);
  return { cliKey, ...CreateCliKeyResponseSchema.parse(await response.json()) };
};

const cliKeyRows = async (userId: string) =>
  (await env.DB.prepare('SELECT id FROM vault_cli_key WHERE user_id = ?').bind(userId).all())
    .results;

const makeSessionsStale = async (userId: string) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?')
    .bind(twoDaysAgo.toISOString(), userId)
    .run();
};

describe('CLI keys', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('opens the vault from the CLI and reads and writes its records', async () => {
    const alice = await signUp('alice@example.com');
    const browserVault = await openVault(alice.unlockKey, alice.wrappedDek);
    const address = await browserVault.encryptRecord({
      type: 'address',
      naturalKey: 'alice@posteo.de',
      revision: 1,
      plaintext: '{"password":"hunter2"}',
    });
    await request(`/api/v1/vault/records/address/${address.id}`, {
      method: 'PUT',
      headers: asSession(alice),
      body: { ciphertext: address.ciphertext, revision: 1 },
    });
    const { cliKey, keyId, token } = await approve(alice);

    const wrapResponse = await request('/api/v1/vault/cli-key', {
      headers: asCliKey(token, alice.userId),
    });
    expect(wrapResponse.status).toBe(200);
    const wrap = CliKeyWrapResponseSchema.parse(await wrapResponse.json());
    expect(wrap.keyId).toBe(keyId);
    const cliVault = await openVault(
      await deriveCliKeys({
        privateKey: cliKey.privateKey,
        ephemeralPublicKey: wrap.ephemeralPublicKey,
      }),
      wrap.wrappedDek,
    );

    const read = await request(`/api/v1/vault/records/address/${address.id}`, {
      headers: asCliKey(token, alice.userId),
    });
    expect(read.status).toBe(200);
    const { ciphertext } = await read.json<{ ciphertext: string }>();
    expect(
      await cliVault.decryptRecord({ type: 'address', naturalKey: 'alice@posteo.de', ciphertext }),
    ).toEqual({ revision: 1, plaintext: '{"password":"hunter2"}' });

    const draft = await cliVault.encryptRecord({
      type: 'draft',
      naturalKey: 'd1',
      revision: 1,
      plaintext: 'from the terminal',
    });
    const written = await request(`/api/v1/vault/records/draft/${draft.id}`, {
      method: 'PUT',
      headers: asCliKey(token, alice.userId),
      body: { ciphertext: draft.ciphertext, revision: 1, precondition: { expect: 'absent' } },
    });
    expect(written.status).toBe(200);
    const listed = await request('/api/v1/vault/records/draft', { headers: asSession(alice) });
    const [record] = (await listed.json<{ records: { id: string; ciphertext: string }[] }>())
      .records;
    expect(await browserVault.decryptListedRecord('draft', record!)).toMatchObject({
      plaintext: 'from the terminal',
    });
  });

  it('keeps only the hash of the token, and stamps the key used when the CLI fetches its wrap', async () => {
    const alice = await signUp('alice@example.com');
    const { keyId, token, cliKey } = await approve(alice, '  laptop  ');

    const stored = await env.DB.prepare('SELECT * FROM vault_cli_key WHERE id = ?')
      .bind(keyId)
      .first<Record<string, unknown>>();
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ).toBase64({ alphabet: 'base64url', omitPadding: true });
    expect(stored).toMatchObject({
      user_id: alice.userId,
      name: 'laptop',
      public_key: cliKey.publicKey,
      token_hash: hash,
      last_used_at: null,
    });
    // After the key id, not after the last `_`: base64url can put one inside the secret.
    const secret = token.slice(`yozzcli_${keyId}_`.length);
    expect(secret).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(secret);

    const listBefore = ListCliKeysResponseSchema.parse(
      await (await request('/api/v1/vault/cli-keys', { headers: asSession(alice) })).json(),
    );
    expect(listBefore.keys).toEqual([
      {
        keyId,
        name: 'laptop',
        publicKey: cliKey.publicKey,
        createdAt: expect.any(Number),
        lastUsedAt: null,
      },
    ]);

    await request('/api/v1/vault/cli-key', { headers: asCliKey(token, alice.userId) });

    const listAfter = ListCliKeysResponseSchema.parse(
      await (await request('/api/v1/vault/cli-keys', { headers: asSession(alice) })).json(),
    );
    expect(listAfter.keys[0]?.lastUsedAt).toEqual(expect.any(Number));
  });

  it('lists this account’s keys and no one else’s', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const mine = await approve(alice, 'mine');
    await approve(bob, 'theirs');

    const listed = ListCliKeysResponseSchema.parse(
      await (await request('/api/v1/vault/cli-keys', { headers: asSession(alice) })).json(),
    );

    expect(listed.keys.map(({ keyId }) => keyId)).toEqual([mine.keyId]);
  });

  it.each([
    ['GET', '/api/v1/vault/unlock'],
    ['PUT', '/api/v1/vault/unlock'],
    ['PUT', '/api/v1/vault/unlock/password'],
    ['DELETE', '/api/v1/vault'],
    ['DELETE', '/api/v1/account'],
    ['GET', '/api/v1/vault/cli-keys'],
    ['POST', '/api/v1/vault/cli-keys'],
    ['GET', '/api/v1/autoconfig?domain=example.com'],
    ['GET', '/api/auth/passkey/generate-register-options'],
    ['GET', '/api/auth/passkey/list-user-passkeys'],
    ['POST', '/api/auth/sign-out'],
  ])('refuses a CLI key on %s %s, and changes nothing', async (method, path) => {
    const alice = await signUp('alice@example.com');
    const { token } = await approve(alice);
    const before = (await env.DB.prepare('SELECT * FROM vault_account').all()).results;

    const response = await request(path, {
      method,
      headers: asCliKey(token, alice.userId),
      body: method === 'GET' ? undefined : {},
    });

    expect([401, 403]).toContain(response.status);
    expect((await env.DB.prepare('SELECT * FROM vault_account').all()).results).toEqual(before);
    expect(await cliKeyRows(alice.userId)).toHaveLength(1);
  });

  it('refuses a CLI key on the relay', async () => {
    const alice = await signUp('alice@example.com');
    const { token } = await approve(alice);

    const response = await request('/api/v1/relay?host=imap.example.com&port=993', {
      headers: { ...asCliKey(token, alice.userId), Upgrade: 'websocket' },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a bearer that is not this key’s token, and is not rescued by a cookie beside it', async () => {
    const alice = await signUp('alice@example.com');
    const { keyId, token } = await approve(alice);
    const forged = `yozzcli_${keyId}_${'A'.repeat(43)}`;

    for (const bearer of [forged, token.slice(0, -1), `${token}x`, 'yozzcli_garbage']) {
      const response = await request('/api/v1/vault/records/draft', {
        headers: { ...asCliKey(bearer, alice.userId), Cookie: alice.cookie },
      });
      expect(response.status, bearer).toBe(401);
    }
    const wrongScheme = await request('/api/v1/vault/cli-key', {
      headers: { Authorization: `Basic ${token}`, [ACCOUNT_HEADER]: alice.userId },
    });
    expect(wrongScheme.status).toBe(401);
  });

  it('refuses a session on the route that answers a key’s own wrap', async () => {
    const alice = await signUp('alice@example.com');
    await approve(alice);

    const response = await request('/api/v1/vault/cli-key', { headers: asSession(alice) });

    expect(response.status).toBe(401);
  });

  it('refuses a request named for another account, or for none', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const { token } = await approve(alice);

    for (const path of ['/api/v1/vault/cli-key', '/api/v1/vault/records/draft']) {
      const other = await request(path, { headers: asCliKey(token, bob.userId) });
      expect(other.status, path).toBe(403);
      expect(await other.json(), path).toMatchObject({ error: { code: 'ACCOUNT_MISMATCH' } });

      const unnamed = await request(path, { headers: { Authorization: `Bearer ${token}` } });
      expect(unnamed.status, path).toBe(403);
    }
  });

  it('stops a revoked key at once, and leaves the others', async () => {
    const alice = await signUp('alice@example.com');
    const revoked = await approve(alice, 'old');
    const kept = await approve(alice, 'new');

    const response = await request(`/api/v1/vault/cli-keys/${revoked.keyId}`, {
      method: 'DELETE',
      headers: asSession(alice),
    });

    expect(response.status).toBe(200);
    for (const path of ['/api/v1/vault/cli-key', '/api/v1/vault/records/draft']) {
      expect((await request(path, { headers: asCliKey(revoked.token, alice.userId) })).status).toBe(
        401,
      );
    }
    expect(
      (await request('/api/v1/vault/cli-key', { headers: asCliKey(kept.token, alice.userId) }))
        .status,
    ).toBe(200);
  });

  it('lets a key remove itself, and no other key', async () => {
    const alice = await signUp('alice@example.com');
    const one = await approve(alice, 'one');
    const two = await approve(alice, 'two');
    await makeSessionsStale(alice.userId);

    const other = await request(`/api/v1/vault/cli-keys/${two.keyId}`, {
      method: 'DELETE',
      headers: asCliKey(one.token, alice.userId),
    });
    expect(other.status).toBe(403);
    expect(await cliKeyRows(alice.userId)).toHaveLength(2);

    // Its own bearer needs no fresh session: `yozz logout` has none.
    const own = await request(`/api/v1/vault/cli-keys/${one.keyId}`, {
      method: 'DELETE',
      headers: asCliKey(one.token, alice.userId),
    });
    expect(own.status).toBe(200);
    expect(await cliKeyRows(alice.userId)).toEqual([{ id: two.keyId }]);
  });

  it('refuses to remove another account’s key, and answers as if it were not there', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const bobs = await approve(bob);

    for (const keyId of [bobs.keyId, crypto.randomUUID(), 'not-a-key-id']) {
      const response = await request(`/api/v1/vault/cli-keys/${keyId}`, {
        method: 'DELETE',
        headers: asSession(alice),
      });
      expect(response.status, keyId).toBe(404);
    }
    expect(await cliKeyRows(bob.userId)).toHaveLength(1);
  });

  it('refuses a stale session, to create a key or to revoke one', async () => {
    const alice = await signUp('alice@example.com');
    const { keyId } = await approve(alice);
    await makeSessionsStale(alice.userId);

    const revoke = await request(`/api/v1/vault/cli-keys/${keyId}`, {
      method: 'DELETE',
      headers: asSession(alice),
    });
    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toMatchObject({ error: { code: 'SESSION_NOT_FRESH' } });

    const cliKey = await generateCliKeyPair();
    const approval = await deriveApprovalKeys(cliKey.publicKey);
    const create = await request('/api/v1/vault/cli-keys', {
      method: 'POST',
      headers: asSession(alice),
      body: {
        name: 'late',
        publicKey: cliKey.publicKey,
        ephemeralPublicKey: approval.ephemeralPublicKey,
        wrappedDek: await rewrapDek(alice.unlockKey, approval, alice.wrappedDek),
      },
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({ error: { code: 'SESSION_NOT_FRESH' } });
    expect(await cliKeyRows(alice.userId)).toEqual([{ id: keyId }]);
  });

  it('refuses a body it does not understand', async () => {
    const alice = await signUp('alice@example.com');
    const { publicKey } = await generateCliKeyPair();
    const body = { name: 'box', publicKey, ephemeralPublicKey: publicKey, wrappedDek: 'd3JhcA==' };

    for (const bad of [
      { ...body, name: 'x'.repeat(61) },
      { ...body, publicKey: `${publicKey}A` },
      { ...body, token: 'mine' },
      { name: 'box', publicKey },
    ]) {
      const response = await request('/api/v1/vault/cli-keys', {
        method: 'POST',
        headers: asSession(alice),
        body: bad,
      });
      expect(response.status).toBe(400);
    }
    expect(await cliKeyRows(alice.userId)).toEqual([]);
  });

  it('mints no key for an account with no vault, or for a session that has ended', async () => {
    const alice = await signUp('alice@example.com');
    await env.DB.prepare('DELETE FROM vault_account WHERE user_id = ?').bind(alice.userId).run();
    const { publicKey } = await generateCliKeyPair();
    const body = { name: 'box', publicKey, ephemeralPublicKey: publicKey, wrappedDek: 'd3JhcA==' };

    const noVault = await request('/api/v1/vault/cli-keys', {
      method: 'POST',
      headers: asSession(alice),
      body,
    });
    expect(noVault.status).toBe(409);

    const bob = await signUp('bob@example.com');
    expect(
      await createCliKey(env.DB, bob.userId, {
        ...body,
        keyId: crypto.randomUUID(),
        tokenHash: 'hash',
        sessionId: 'a-session-signed-out-in-flight',
        now: 1000,
      }),
    ).toBe(false);
    expect([...(await cliKeyRows(alice.userId)), ...(await cliKeyRows(bob.userId))]).toEqual([]);
  });

  it('goes with a vault reset', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const { token } = await approve(alice);
    await approve(bob);

    const response = await request('/api/v1/vault', {
      method: 'DELETE',
      headers: asSession(alice),
    });

    expect(response.status).toBe(200);
    expect(await cliKeyRows(alice.userId)).toEqual([]);
    expect(await cliKeyRows(bob.userId)).toHaveLength(1);
    expect(
      (await request('/api/v1/vault/cli-key', { headers: asCliKey(token, alice.userId) })).status,
    ).toBe(401);
  });

  it('goes with the account', async () => {
    const alice = await signUp('alice@example.com');
    const { token } = await approve(alice);

    const response = await request('/api/v1/account', {
      method: 'DELETE',
      headers: asSession(alice),
    });

    expect(response.status).toBe(200);
    expect(await cliKeyRows(alice.userId)).toEqual([]);
    expect(
      (await request('/api/v1/vault/cli-key', { headers: asCliKey(token, alice.userId) })).status,
    ).toBe(401);
  });

  it('does not let a browser send a bearer across origins', async () => {
    const preflight = await createApp().request(
      'http://localhost/api/v1/vault/records/draft',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://yozz.app',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      },
      env,
    );

    const allowed = (preflight.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    expect(allowed).toContain(ACCOUNT_HEADER.toLowerCase());
    expect(allowed).not.toContain('authorization');
  });

  it('refuses a session named for another account, or for none, on every key route', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const { keyId } = await approve(alice);
    const cliKey = await generateCliKeyPair();
    const approval = await deriveApprovalKeys(cliKey.publicKey);
    const body = {
      name: 'box',
      publicKey: cliKey.publicKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
      wrappedDek: await rewrapDek(alice.unlockKey, approval, alice.wrappedDek),
    };

    for (const account of [bob.userId, undefined]) {
      const headers = {
        Cookie: alice.cookie,
        ...(account === undefined ? {} : { [ACCOUNT_HEADER]: account }),
      };
      for (const [method, path] of [
        ['POST', '/api/v1/vault/cli-keys'],
        ['GET', '/api/v1/vault/cli-keys'],
        ['DELETE', `/api/v1/vault/cli-keys/${keyId}`],
      ] as const) {
        const response = await request(path, {
          method,
          headers,
          body: method === 'POST' ? body : undefined,
        });
        expect(response.status, `${method} ${path} as ${account}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_MISMATCH' } });
      }
    }
    expect(await cliKeyRows(alice.userId)).toEqual([{ id: keyId }]);
    expect(await cliKeyRows(bob.userId)).toEqual([]);
  });

  it('answers each key its own wrap, and stamps only that key used', async () => {
    const alice = await signUp('alice@example.com');
    const one = await approve(alice, 'one');
    const two = await approve(alice, 'two');
    const stored = async (keyId: string) =>
      await env.DB.prepare(
        'SELECT ephemeral_public_key, wrapped_dek, last_used_at FROM vault_cli_key WHERE id = ?',
      )
        .bind(keyId)
        .first<{
          ephemeral_public_key: string;
          wrapped_dek: string;
          last_used_at: number | null;
        }>();

    const response = await request('/api/v1/vault/cli-key', {
      headers: asCliKey(two.token, alice.userId),
    });

    const twoRow = await stored(two.keyId);
    expect(CliKeyWrapResponseSchema.parse(await response.json())).toEqual({
      keyId: two.keyId,
      ephemeralPublicKey: twoRow?.ephemeral_public_key,
      wrappedDek: twoRow?.wrapped_dek,
    });
    expect(twoRow?.last_used_at).toEqual(expect.any(Number));
    expect((await stored(one.keyId))?.last_used_at).toBeNull();

    const first = CliKeyWrapResponseSchema.parse(
      await (
        await request('/api/v1/vault/cli-key', { headers: asCliKey(one.token, alice.userId) })
      ).json(),
    );
    expect(first.keyId).toBe(one.keyId);
    expect(first.wrappedDek).toBe((await stored(one.keyId))?.wrapped_dek);
  });

  describe('signing the other devices out', () => {
    const sessionIdOf = async (userId: string): Promise<string> => {
      const session = await env.DB.prepare('SELECT id FROM session WHERE userId = ?')
        .bind(userId)
        .first<{ id: string }>();
      if (session === null) throw new Error(`${userId} has no session`);
      return session.id;
    };

    const authValue = (fill: number) => new Uint8Array(32).fill(fill).toBase64();

    /** Alice in password mode, with a credential for `authValue(1)`, and a CLI key each for her and Bob. */
    const passwordAccounts = async () => {
      const alice = await signUp('alice@example.com');
      const bob = await signUp('bob@example.com');
      const { password } = await createAuth(env).$context;
      await env.DB.prepare(
        `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES ('cred', ?, 'credential', ?, ?, '2026-01-01', '2026-01-01')`,
      )
        .bind(alice.userId, alice.userId, await password.hash(authValue(1)))
        .run();
      return { alice, bob, aliceKey: await approve(alice), bobKey: await approve(bob) };
    };

    it('takes every CLI key with the password change, and no one else’s', async () => {
      const { alice, bob, aliceKey } = await passwordAccounts();

      const response = await request('/api/v1/vault/unlock/password', {
        method: 'PUT',
        headers: asSession(alice),
        body: {
          currentAuthValue: authValue(1),
          newAuthValue: authValue(2),
          wrappedDek: alice.wrappedDek,
        },
      });

      expect(response.status).toBe(200);
      expect(await cliKeyRows(alice.userId)).toEqual([]);
      expect(await cliKeyRows(bob.userId)).toHaveLength(1);
      expect(
        (
          await request('/api/v1/vault/cli-key', {
            headers: asCliKey(aliceKey.token, alice.userId),
          })
        ).status,
      ).toBe(401);
    });

    it('keeps every CLI key when the password change is refused', async () => {
      const { alice } = await passwordAccounts();

      const wrong = await request('/api/v1/vault/unlock/password', {
        method: 'PUT',
        headers: asSession(alice),
        body: {
          currentAuthValue: authValue(9),
          newAuthValue: authValue(2),
          wrappedDek: alice.wrappedDek,
        },
      });
      // The batch itself, raced by another change that moved the hash first.
      const raced = await changePasswordUnlock(env.DB, alice.userId, {
        currentHash: 'a-hash-that-moved-on',
        newHash: 'new-hash',
        wrappedDek: alice.wrappedDek,
        keepSessionId: await sessionIdOf(alice.userId),
        now: 2000,
      });

      expect(wrong.status).toBe(403);
      expect(raced).toBe(false);
      expect(await cliKeyRows(alice.userId)).toHaveLength(1);
    });

    /** Alice in passkey mode with two wrapped passkeys, and a CLI key each for her and Bob. */
    const passkeyAccounts = async () => {
      const alice = await signUp('alice@example.com');
      const bob = await signUp('bob@example.com');
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE vault_account SET unlock_mode = 'passkey', password_wrapped_dek = NULL WHERE user_id = ?",
        ).bind(alice.userId),
        ...['1', '2'].flatMap(n => [
          env.DB.prepare(
            `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
             VALUES (?, 'pk', 'pub', ?, ?, 0, 'platform', 1, 1000)`,
          ).bind(`pk-${n}`, alice.userId, `cred-${n}`),
          env.DB.prepare(
            `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
             VALUES (?, ?, ?, 1000, 1000)`,
          ).bind(alice.userId, `pk-${n}`, alice.wrappedDek),
        ]),
      ]);
      return { alice, bob, aliceKey: await approve(alice), bobKey: await approve(bob) };
    };

    it('takes every CLI key with a removed passkey, and no one else’s', async () => {
      const { alice, bob, aliceKey } = await passkeyAccounts();

      const response = await request('/api/v1/vault/unlock/passkey/cred-1', {
        method: 'DELETE',
        headers: asSession(alice),
      });

      expect(response.status).toBe(200);
      expect(await cliKeyRows(alice.userId)).toEqual([]);
      expect(await cliKeyRows(bob.userId)).toHaveLength(1);
      expect(
        (
          await request('/api/v1/vault/cli-key', {
            headers: asCliKey(aliceKey.token, alice.userId),
          })
        ).status,
      ).toBe(401);
    });

    it('keeps every CLI key when the passkey removal is refused', async () => {
      const { alice } = await passkeyAccounts();
      await request('/api/v1/vault/unlock/passkey/cred-1', {
        method: 'DELETE',
        headers: asSession(alice),
      });
      const aliceKey = await approve(alice);

      const last = await request('/api/v1/vault/unlock/passkey/cred-2', {
        method: 'DELETE',
        headers: asSession(alice),
      });

      expect(last.status).toBe(409);
      expect(await cliKeyRows(alice.userId)).toEqual([{ id: aliceKey.keyId }]);
    });

    it('is not what a switch of unlock mode does, so a switch keeps CLI keys', async () => {
      const { alice, aliceKey } = await passwordAccounts();
      await env.DB.prepare(
        `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
         VALUES ('pk-1', 'pk', 'pub', ?, 'cred-1', 0, 'platform', 1, 1000)`,
      )
        .bind(alice.userId)
        .run();

      const toPasskey = await request('/api/v1/vault/unlock', {
        method: 'PUT',
        headers: asSession(alice),
        body: {
          mode: 'passkey',
          isNewVault: false,
          credentialId: 'cred-1',
          wrappedDek: alice.wrappedDek,
        },
      });
      const toPassword = await request('/api/v1/vault/unlock', {
        method: 'PUT',
        headers: asSession(alice),
        body: {
          mode: 'password',
          isNewVault: false,
          wrappedDek: alice.wrappedDek,
          authValue: authValue(3),
        },
      });

      expect([toPasskey.status, toPassword.status]).toEqual([200, 200]);
      expect(await cliKeyRows(alice.userId)).toEqual([{ id: aliceKey.keyId }]);
      expect(
        (
          await request('/api/v1/vault/cli-key', {
            headers: asCliKey(aliceKey.token, alice.userId),
          })
        ).status,
      ).toBe(200);
    });
  });
});
