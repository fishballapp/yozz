import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { applyMigrations } from './apply-migrations.ts';

describe('Worker records CRUD and isolation routes', () => {
  const loginWithMagicLink = async (
    email: string,
    name = 'Record User',
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

  /** A refused write must change nothing, so every case asserts the stored ciphertext afterwards. */
  describe('compare-and-swap', () => {
    const put = async (
      app: ReturnType<typeof createApp>,
      headers: Record<string, string>,
      body: Record<string, unknown>,
    ) =>
      app.request(
        'http://localhost/api/v1/vault/records/draft/blind-draft-1',
        { method: 'PUT', headers, body: JSON.stringify(body) },
        env,
      );

    const storedCiphertext = async (
      app: ReturnType<typeof createApp>,
      headers: Record<string, string>,
    ) => {
      const res = await app.request(
        'http://localhost/api/v1/vault/records/draft/blind-draft-1',
        { method: 'GET', headers },
        env,
      );
      if (res.status !== 200) return null;
      return await res.json<{ ciphertext: string; revision: number | null }>();
    };

    it('creates only when there is no row, and refuses the second create', async () => {
      const user = await loginWithMagicLink('cas1@example.com', 'CAS');
      const app = createApp();

      const first = await put(app, user.headers, {
        ciphertext: 'Zmlyc3Q=',
        revision: 1,
        precondition: { expect: 'absent' },
      });
      expect(first.status).toBe(200);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({
        ciphertext: 'Zmlyc3Q=',
        revision: 1,
      });

      const second = await put(app, user.headers, {
        ciphertext: 'c2Vjb25k',
        revision: 1,
        precondition: { expect: 'absent' },
      });
      expect(second.status).toBe(409);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ ciphertext: 'Zmlyc3Q=' });
    });

    it('updates from the exact revision and refuses a stale one', async () => {
      const user = await loginWithMagicLink('cas2@example.com', 'CAS');
      const app = createApp();
      await put(app, user.headers, {
        ciphertext: 'Zmlyc3Q=',
        revision: 1,
        precondition: { expect: 'absent' },
      });

      const stale = await put(app, user.headers, {
        ciphertext: 'c3RhbGU=',
        revision: 2,
        precondition: { expect: 'revision', revision: 7 },
      });
      expect(stale.status).toBe(409);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ ciphertext: 'Zmlyc3Q=' });

      const fresh = await put(app, user.headers, {
        ciphertext: 'ZnJlc2g=',
        revision: 2,
        precondition: { expect: 'revision', revision: 1 },
      });
      expect(fresh.status).toBe(200);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({
        ciphertext: 'ZnJlc2g=',
        revision: 2,
      });
    });

    it('fills a pre-CAS row on `revision: null`, and refuses that claim once it is set', async () => {
      const user = await loginWithMagicLink('cas3@example.com', 'CAS');
      const app = createApp();
      await env.DB.prepare(
        'INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(user.userId, 'blind-draft-1', 'draft', 'b2xk', Date.now())
        .run();
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ revision: null });

      const filled = await put(app, user.headers, {
        ciphertext: 'ZmlsbGVk',
        revision: 5,
        precondition: { expect: 'revision', revision: null },
      });
      expect(filled.status).toBe(200);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ revision: 5 });

      const again = await put(app, user.headers, {
        ciphertext: 'YWdhaW4=',
        revision: 6,
        precondition: { expect: 'revision', revision: null },
      });
      expect(again.status).toBe(409);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ ciphertext: 'ZmlsbGVk' });
    });

    it('deletes only the stated revision, and leaves a moved-on row alone', async () => {
      const user = await loginWithMagicLink('cas4@example.com', 'CAS');
      const app = createApp();
      await put(app, user.headers, {
        ciphertext: 'Zmlyc3Q=',
        revision: 3,
        precondition: { expect: 'absent' },
      });

      const wrong = await app.request(
        'http://localhost/api/v1/vault/records/draft/blind-draft-1?ifRevision=2',
        { method: 'DELETE', headers: user.headers },
        env,
      );
      expect(wrong.status).toBe(409);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({ ciphertext: 'Zmlyc3Q=' });

      const right = await app.request(
        'http://localhost/api/v1/vault/records/draft/blind-draft-1?ifRevision=3',
        { method: 'DELETE', headers: user.headers },
        env,
      );
      expect(right.status).toBe(200);
      expect(await storedCiphertext(app, user.headers)).toBeNull();
    });

    it('leaves a stated write with no opinion behaving exactly as before', async () => {
      const user = await loginWithMagicLink('cas5@example.com', 'CAS');
      const app = createApp();
      await put(app, user.headers, { ciphertext: 'Zmlyc3Q=', revision: 1 });
      const second = await put(app, user.headers, { ciphertext: 'c2Vjb25k', revision: 2 });
      expect(second.status).toBe(200);
      expect(await storedCiphertext(app, user.headers)).toMatchObject({
        ciphertext: 'c2Vjb25k',
        revision: 2,
      });
    });
  });

  it('puts, gets, and deletes records with strict user isolation', async () => {
    const user1 = await loginWithMagicLink('user1@example.com', 'User One');
    const user2 = await loginWithMagicLink('user2@example.com', 'User Two');
    const app = createApp();

    const putRes = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWFjYy0x', revision: 1 }),
      },
      env,
    );
    expect(putRes.status).toBe(200);

    const getRes1 = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user1.headers },
      env,
    );
    expect(getRes1.status).toBe(200);
    const body1 = await getRes1.json<{
      id: string;
      type: string;
      ciphertext: string;
      updatedAt: number;
    }>();
    expect(body1.id).toBe('blind-acc-1');
    expect(body1.type).toBe('account');
    expect(body1.ciphertext).toBe('Y2lwaGVyLWFjYy0x');

    const getRes2 = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user2.headers },
      env,
    );
    expect(getRes2.status).toBe(404);

    await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'DELETE', headers: user2.headers },
      env,
    );

    const checkStillExists = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user1.headers },
      env,
    );
    expect(checkStillExists.status).toBe(200);

    const delRes = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'DELETE', headers: user1.headers },
      env,
    );
    expect(delRes.status).toBe(200);

    const checkGone = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user1.headers },
      env,
    );
    expect(checkGone.status).toBe(404);
  });

  it('rejects same-id different-type PUT with 409 CONFLICT', async () => {
    const user1 = await loginWithMagicLink('conflict@example.com');
    const app = createApp();

    await app.request(
      'http://localhost/api/v1/vault/records/account/same-blind-id',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLTE=', revision: 1 }),
      },
      env,
    );

    const conflictRes = await app.request(
      'http://localhost/api/v1/vault/records/identity/same-blind-id',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLTI=', revision: 1 }),
      },
      env,
    );

    expect(conflictRes.status).toBe(409);
    const body = await conflictRes.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('strictly paginates by blind id and isolates by type and user', async () => {
    const user1 = await loginWithMagicLink('page1@example.com');
    const user2 = await loginWithMagicLink('page2@example.com');
    const app = createApp();

    await app.request(
      'http://localhost/api/v1/vault/records/account/id-a',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWE=', revision: 1 }),
      },
      env,
    );
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-b',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWI=', revision: 1 }),
      },
      env,
    );
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-c',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWM=', revision: 1 }),
      },
      env,
    );

    await app.request(
      'http://localhost/api/v1/vault/records/identity/id-d',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWQ=', revision: 1 }),
      },
      env,
    );

    await app.request(
      'http://localhost/api/v1/vault/records/account/id-e',
      {
        method: 'PUT',
        headers: user2.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWU=', revision: 1 }),
      },
      env,
    );

    const listRes = await app.request(
      'http://localhost/api/v1/vault/records/account',
      { method: 'GET', headers: user1.headers },
      env,
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json<{
      records: { id: string }[];
      nextCursor: string | null;
    }>();

    expect(listBody.records.map(r => r.id)).toEqual(['id-a', 'id-b', 'id-c']);

    const listIdentityRes = await app.request(
      'http://localhost/api/v1/vault/records/identity',
      { method: 'GET', headers: user1.headers },
      env,
    );
    const listIdentityBody = await listIdentityRes.json<{ records: { id: string }[] }>();
    expect(listIdentityBody.records.map(r => r.id)).toEqual(['id-d']);
  });

  it('rejects relationship-leaking and arbitrary search query parameters', async () => {
    const user1 = await loginWithMagicLink('querytest@example.com');
    const app = createApp();

    const badQueries = [
      '?ids=id-a,id-b',
      '?q=search-term',
      '?sort=updated_at',
      '?filter=all',
      '?unknown=123',
    ];

    for (const q of badQueries) {
      const res = await app.request(
        `http://localhost/api/v1/vault/records/account${q}`,
        { method: 'GET', headers: user1.headers },
        env,
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects payload exceeding body limit', async () => {
    const user1 = await loginWithMagicLink('bodylimit@example.com');
    const app = createApp();
    const oversized = 'a'.repeat(3 * 1024 * 1024); // 3MB

    const res = await app.request(
      'http://localhost/api/v1/vault/records/account/id-huge',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: oversized, revision: 1 }),
      },
      env,
    );

    expect([400, 413]).toContain(res.status);
  });
});
