import { env } from 'cloudflare:test';
import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { deleteAccount as deleteAccountRows } from '../src/db/account.ts';
import { putRecord } from '../src/db/records.ts';
import { finalizePasswordUnlock } from '../src/db/unlock.ts';
import { applyMigrations } from './apply-migrations.ts';

type Person = { readonly userId: string; readonly email: string; readonly cookie: string };

const signIn = async (email: string): Promise<Person> => {
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
  return { userId: user.id, email, cookie: verified.headers.get('set-cookie') ?? '' };
};

/** One of every kind of row an account owns: vault, passkey, CLI key, password credential, challenges. */
const seedAccount = async ({ userId, email }: Person) => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
       VALUES (?, 'passkey', NULL, 1000, 1000)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
       VALUES (?, 'pk', 'pub', ?, ?, 0, 'platform', 1, 1000)`,
    ).bind(`pk-${userId}`, userId, `cred-${userId}`),
    env.DB.prepare(
      `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
       VALUES (?, ?, 'wrap', 1000, 1000)`,
    ).bind(userId, `pk-${userId}`),
    env.DB.prepare(
      `INSERT INTO vault_cli_key (id, user_id, name, public_key, ephemeral_public_key, wrapped_dek, token_hash, created_at)
       VALUES (?, ?, 'box', 'pub', 'eph', 'wrap', 'hash', 1000)`,
    ).bind(`key-${userId}`, userId),
    ...['rec-1', 'rec-2'].map(id =>
      env.DB.prepare(
        `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
         VALUES (?, ?, 'address', 'Y2lwaGVy', 1000, 1)`,
      ).bind(userId, id),
    ),
    env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?, ?, 'credential', ?, 'hash', 1000, 1000)`,
    ).bind(`acct-${userId}`, userId, userId),
    // A pending magic link names the address; a passkey challenge names the user.
    env.DB.prepare(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, 'link-token', ?, 9999999999999, 1000, 1000)`,
    ).bind(
      `v-link-${userId}`,
      JSON.stringify({ email: email.toUpperCase(), name: 'Neutral Name' }),
    ),
    env.DB.prepare(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, 'challenge-token', ?, 9999999999999, 1000, 1000)`,
    ).bind(
      `v-challenge-${userId}`,
      JSON.stringify({ expectedChallenge: 'c', userData: { id: userId } }),
    ),
    // Email verification and password reset key their row by the address itself.
    env.DB.prepare(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, 'opaque-token', 9999999999999, 1000, 1000)`,
    ).bind(`v-email-${userId}`, email),
  ]);
};

/** Every table in the schema, which a test must be able to seed and a deletion must reach. */
const TABLES = [
  'account',
  'passkey',
  'session',
  'user',
  'vault_account',
  'vault_cli_key',
  'vault_passkey_wrap',
  'vault_record',
  'verification',
];

const tablesOfSchema = async (): Promise<string[]> =>
  (
    await env.DB.prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'
         ORDER BY name`,
    ).all<{ name: string }>()
  ).results.map(({ name }) => name);

/** Every row of every table, found through `sqlite_master`, in which any column mentions the user's id or address. */
const mentionsOf = async ({ userId, email }: Person) => {
  const mentions: Record<string, unknown[]> = {};
  for (const table of await tablesOfSchema()) {
    const columns = (
      await env.DB.prepare('SELECT name FROM pragma_table_info(?)').bind(table).all<{
        name: string;
      }>()
    ).results.map(({ name }) => name);
    const clauses = columns.flatMap(column => [
      `instr(lower(CAST("${column}" AS TEXT)), lower(?)) > 0`,
      `instr(lower(CAST("${column}" AS TEXT)), lower(?)) > 0`,
    ]);
    mentions[table] = (
      await env.DB.prepare(`SELECT * FROM "${table}" WHERE ${clauses.join(' OR ')} ORDER BY 1, 2`)
        .bind(...columns.flatMap(() => [userId, email]))
        .all()
    ).results;
  }
  return mentions;
};

describe('DELETE /api/v1/account', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  const deleteAccount = async (
    { cookie }: Pick<Person, 'cookie'>,
    account: string | undefined,
  ): Promise<Response> =>
    await createApp().request(
      'http://localhost/api/v1/account',
      {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          Origin: 'https://yozz.app',
          ...(account === undefined ? {} : { [ACCOUNT_HEADER]: account }),
        },
      },
      env,
    );

  const makeSessionsStale = async (userId: string) => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await env.DB.prepare('UPDATE session SET createdAt = ? WHERE userId = ?')
      .bind(twoDaysAgo.toISOString(), userId)
      .run();
  };

  it('leaves no row in any table that mentions the user, and every row of anyone else', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    await seedAccount(alice);
    await seedAccount(bob);
    // The seed reaches every table, so an empty walk afterwards means something.
    expect(await tablesOfSchema()).toEqual(TABLES);
    const aliceBefore = await mentionsOf(alice);
    const bobBefore = await mentionsOf(bob);
    for (const table of TABLES) {
      expect(aliceBefore[table], table).not.toHaveLength(0);
      expect(bobBefore[table], table).not.toHaveLength(0);
    }

    const response = await deleteAccount(alice, alice.userId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const aliceAfter = await mentionsOf(alice);
    for (const table of TABLES) expect(aliceAfter[table], table).toHaveLength(0);
    expect(await mentionsOf(bob)).toEqual(bobBefore);
  });

  it('expires the session cookie it just deleted the session of', async () => {
    const alice = await signIn('alice@example.com');

    const response = await deleteAccount(alice, alice.userId);

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some(cookie => /session_token=;/.test(cookie) && /Max-Age=0/i.test(cookie)),
    ).toBe(true);
  });

  it('lets the same address register again as a new account', async () => {
    const first = await signIn('alice@example.com');
    await seedAccount(first);
    await deleteAccount(first, first.userId);

    const second = await signIn('alice@example.com');

    expect(second.userId).not.toBe(first.userId);
    expect(await mentionsOf(second)).toMatchObject({
      vault_account: [],
      vault_record: [],
      passkey: [],
    });
  });

  it('refuses a stale session and deletes nothing', async () => {
    const alice = await signIn('alice@example.com');
    await seedAccount(alice);
    await makeSessionsStale(alice.userId);
    const before = await mentionsOf(alice);

    const response = await deleteAccount(alice, alice.userId);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'SESSION_NOT_FRESH' } });
    expect(await mentionsOf(alice)).toEqual(before);
  });

  it('refuses a signed-out request and deletes nothing', async () => {
    const alice = await signIn('alice@example.com');
    await seedAccount(alice);
    const before = await mentionsOf(alice);

    const response = await deleteAccount({ cookie: '' }, alice.userId);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(await mentionsOf(alice)).toEqual(before);
  });

  it('refuses a request made for another account than the session’s', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    await seedAccount(alice);
    await seedAccount(bob);
    const bobBefore = await mentionsOf(bob);

    const response = await deleteAccount(bob, alice.userId);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_MISMATCH' } });
    expect(await mentionsOf(bob)).toEqual(bobBefore);
  });

  it('leaves everything in place when a statement of the batch fails', async () => {
    const alice = await signIn('alice@example.com');
    await seedAccount(alice);
    const before = await mentionsOf(alice);
    // The last statement of the batch: the user row refuses to go.
    await env.DB.exec(
      `CREATE TRIGGER refuse_user_delete BEFORE DELETE ON user BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );

    const response = await deleteAccount(alice, alice.userId);

    expect(response.status).toBe(500);
    expect(await mentionsOf(alice)).toEqual(before);
  });

  describe('the pending sign-ins it leaves alone', () => {
    const insertVerification = (id: string, identifier: string, value: string) =>
      env.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 9999999999999, 1000, 1000)`,
      )
        .bind(id, identifier, value)
        .run();

    const verificationIds = async () =>
      (
        await env.DB.prepare('SELECT id FROM verification ORDER BY id').all<{ id: string }>()
      ).results.map(({ id }) => id);

    it('keeps rows of other people that only mention her address, and removes hers', async () => {
      const alice = await signIn('alice@example.com');
      const address = alice.email;
      const kept: Record<string, [identifier: string, value: string]> = {
        // Bob's own pending link, under a name that is Alice's address.
        'name-is-her-address': ['t1', JSON.stringify({ email: 'bob@example.com', name: address })],
        'name-quotes-her-address': [
          't2',
          JSON.stringify({ email: 'bob@example.com', name: `"${address}"` }),
        ],
        'name-escapes-her-address': [
          't3',
          JSON.stringify({ email: 'bob@example.com', name: `\\"${address}\\"` }),
        ],
        'name-is-json-claiming-her': [
          't4',
          JSON.stringify({
            email: 'bob@example.com',
            name: JSON.stringify({ email: address, userData: { id: alice.userId } }),
          }),
        ],
        // Her address is the end of this one.
        'address-she-is-a-suffix-of': ['t5', JSON.stringify({ email: `m${address}`, name: 'M' })],
        'identifier-she-is-a-suffix-of': [`m${address}`, 'opaque'],
        // A pending sign-up for an address with no user row yet.
        'sign-up-without-user': [
          't6',
          JSON.stringify({ email: 'carol@example.com', name: 'Carol' }),
        ],
        'not-json': ['t7', `not json, mentions ${address}`],
      };
      for (const [id, [identifier, value]] of Object.entries(kept)) {
        await insertVerification(id, identifier, value);
      }
      await insertVerification(
        'hers-by-mixed-case-email',
        't8',
        JSON.stringify({ email: 'ALICE@Example.COM', name: 'x' }),
      );
      await insertVerification(
        'hers-by-user-id',
        't9',
        JSON.stringify({ userData: { id: alice.userId } }),
      );
      await insertVerification('hers-by-identifier', address.toUpperCase(), 'opaque');

      expect((await deleteAccount(alice, alice.userId)).status).toBe(200);

      expect(await verificationIds()).toEqual(Object.keys(kept).sort());
    });
  });

  describe('a write that passed its session check and lands after the delete', () => {
    const REFUSED = /FOREIGN KEY/;

    it('is refused by the route, as a 401, and leaves no row under the dead user id', async () => {
      const alice = await signIn('alice@example.com');
      await seedAccount(alice);
      // The delete commits after `PUT /records` authenticated, immediately before its INSERT.
      const racing = new Proxy(env.DB, {
        get: (target, property) => {
          if (property !== 'prepare') {
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('INSERT INTO vault_record')) return statement;
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  await deleteAccountRows(target, alice);
                  return statement.bind(...values).run();
                },
              }),
            };
          };
        },
      });

      const response = await createApp().request(
        'http://localhost/api/v1/vault/records/draft/late-autosave',
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Cookie: alice.cookie,
            Origin: 'https://yozz.app',
            [ACCOUNT_HEADER]: alice.userId,
          },
          body: JSON.stringify({ ciphertext: 'Y2lwaGVy', revision: 1 }),
        },
        { ...env, DB: racing },
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
      for (const rows of Object.values(await mentionsOf(alice))) expect(rows).toHaveLength(0);
    });

    it('is refused for a record, an enrolment and a rewrap alike', async () => {
      const alice = await signIn('alice@example.com');
      await deleteAccountRows(env.DB, alice);

      await expect(
        putRecord(env.DB, alice.userId, 'draft', 'late', 'Y2lwaGVy', 1, 1000),
      ).rejects.toThrow(REFUSED);
      // The session went with the account, so the guarded batch writes nothing at all.
      for (const isNewVault of [true, false]) {
        expect(
          await finalizePasswordUnlock(env.DB, alice.userId, {
            isNewVault,
            wrappedDek: 'wrap',
            passwordHash: 'hash',
            sessionId: 'a-session-that-went-with-the-account',
            now: 1000,
          }),
        ).toBe(false);
      }
      await expect(
        env.DB.prepare(
          `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
           VALUES (?, 'pk', 'wrap', 1000, 1000)`,
        )
          .bind(alice.userId)
          .run(),
      ).rejects.toThrow(REFUSED);
      for (const rows of Object.values(await mentionsOf(alice))) expect(rows).toHaveLength(0);
    });
  });
});
