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

  it('puts, gets, and deletes records with strict user isolation', async () => {
    const user1 = await loginWithMagicLink('user1@example.com', 'User One');
    const user2 = await loginWithMagicLink('user2@example.com', 'User Two');
    const app = createApp();

    // User 1 puts a record
    const putRes = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWFjYy0x' }),
      },
      env,
    );
    expect(putRes.status).toBe(200);

    // User 1 can get the record
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

    // User 2 CANNOT read User 1's record (returns 404)
    const getRes2 = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user2.headers },
      env,
    );
    expect(getRes2.status).toBe(404);

    // User 2 cannot delete User 1's record
    await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'DELETE', headers: user2.headers },
      env,
    );

    // Record should still exist for User 1
    const checkStillExists = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'GET', headers: user1.headers },
      env,
    );
    expect(checkStillExists.status).toBe(200);

    // User 1 deletes their record
    const delRes = await app.request(
      'http://localhost/api/v1/vault/records/account/blind-acc-1',
      { method: 'DELETE', headers: user1.headers },
      env,
    );
    expect(delRes.status).toBe(200);

    // Record is now gone
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

    // Put as account
    await app.request(
      'http://localhost/api/v1/vault/records/account/same-blind-id',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLTE=' }),
      },
      env,
    );

    // Put same blind-id as identity must fail with 409
    const conflictRes = await app.request(
      'http://localhost/api/v1/vault/records/identity/same-blind-id',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLTI=' }),
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

    // Insert 3 account records for user 1
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-a',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWE=' }),
      },
      env,
    );
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-b',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWI=' }),
      },
      env,
    );
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-c',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWM=' }),
      },
      env,
    );

    // Insert 1 identity record for user 1
    await app.request(
      'http://localhost/api/v1/vault/records/identity/id-d',
      {
        method: 'PUT',
        headers: user1.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWQ=' }),
      },
      env,
    );

    // Insert 1 account record for user 2
    await app.request(
      'http://localhost/api/v1/vault/records/account/id-e',
      {
        method: 'PUT',
        headers: user2.headers,
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWU=' }),
      },
      env,
    );

    // User 1 listing account should see only id-a, id-b, id-c in order
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

    // Listing identity should see only id-d
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
        body: JSON.stringify({ ciphertext: oversized }),
      },
      env,
    );

    expect([400, 413]).toContain(res.status);
  });
});
