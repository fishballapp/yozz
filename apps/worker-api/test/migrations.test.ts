import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, applyPendingMigrations } from './apply-migrations.ts';

describe('D1 migrations and schema invariants', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
    // The vault tables reference "user", so a vault row needs its user first.
    await env.DB.batch(
      ['user-1', 'user-2', 'user-3'].map(id =>
        env.DB.prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1000, 1000)',
        ).bind(id, id, `${id}@example.com`),
      ),
    );
  });

  it('vault_record has exactly the specified columns: revision, and no device id', async () => {
    const info = await env.DB.prepare('PRAGMA table_info(vault_record)').all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>();

    const columns = info.results.map((col: { name: string }) => col.name);
    expect(columns).toEqual(['user_id', 'id', 'type', 'ciphertext', 'updated_at', 'revision']);

    expect(info.results.find(col => col.name === 'revision')?.notnull).toBe(0);
    expect(columns).not.toContain('device_id');
    expect(columns).not.toContain('deviceId');
  });

  it('vault_account has the EXACT five columns specified', async () => {
    const info = await env.DB.prepare('PRAGMA table_info(vault_account)').all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>();

    const columns = info.results.map((col: { name: string }) => col.name);
    expect(columns).toEqual([
      'user_id',
      'unlock_mode',
      'password_wrapped_dek',
      'created_at',
      'updated_at',
    ]);
  });

  it('vault_passkey_wrap has the EXACT five columns specified', async () => {
    const info = await env.DB.prepare('PRAGMA table_info(vault_passkey_wrap)').all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>();

    const columns = info.results.map((col: { name: string }) => col.name);
    expect(columns).toEqual(['user_id', 'passkey_id', 'wrapped_dek', 'created_at', 'updated_at']);
  });

  it('enforces row check: password mode requires non-null password_wrapped_dek', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-1', 'password', null, 1000, 1000)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-1', 'password', 'wrapped-dek-value', 1000, 1000)
        .run(),
    ).resolves.toBeDefined();
  });

  it('enforces row check: passkey mode requires null password_wrapped_dek', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-2', 'passkey', 'should-be-null', 1000, 1000)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-2', 'passkey', null, 1000, 1000)
        .run(),
    ).resolves.toBeDefined();
  });

  it('enforces row check: invalid unlock_mode is rejected', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-3', 'oauth', 'token', 1000, 1000)
        .run(),
    ).rejects.toThrow();
  });

  it('enforces uniqueness on vault_passkey_wrap (user_id, passkey_id)', async () => {
    await env.DB.prepare(
      'INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('user-1', 'pk-1', 'wrap-1', 1000, 1000)
      .run();

    await expect(
      env.DB.prepare(
        'INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('user-1', 'pk-1', 'wrap-2', 1001, 1001)
        .run(),
    ).rejects.toThrow();
  });

  it('immutable email trigger aborts any email update on user table', async () => {
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('user-immutable', 'Test', 'initial@example.com', 1, 1000, 1000)
      .run();

    await expect(
      env.DB.prepare('UPDATE "user" SET email = ? WHERE id = ?')
        .bind('changed@example.com', 'user-immutable')
        .run(),
    ).rejects.toThrow(/user email is immutable/);

    await expect(
      env.DB.prepare('UPDATE "user" SET email = ?, name = ? WHERE id = ?')
        .bind('initial@example.com', 'New Name', 'user-immutable')
        .run(),
    ).resolves.toBeDefined();
  });

  const foreignKeysOf = async (table: string) =>
    (
      await env.DB.prepare(
        'SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)',
      )
        .bind(table)
        .all()
    ).results;

  it.each(['vault_account', 'vault_passkey_wrap', 'vault_record'])(
    '%s belongs to a user and goes with them',
    async table => {
      expect(await foreignKeysOf(table)).toEqual([
        { from: 'user_id', table: 'user', to: 'id', on_delete: 'CASCADE' },
      ]);
    },
  );

  it('enforces foreign keys, so a write for a user that is gone is refused', async () => {
    expect(await env.DB.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);

    await expect(
      env.DB.prepare(
        `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
         VALUES ('ghost', 'rec', 'draft', 'Y2lwaGVy', 1000, 1)`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.DB.prepare(
        `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
         VALUES ('ghost', 'pk', 'wrap', 1000, 1000)`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.DB.prepare(
        `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
         VALUES ('ghost', 'password', 'wrap', 1000, 1000)`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('deleting the user alone deletes their vault', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
         VALUES ('user-1', 'password', 'wrap', 1000, 1000)`,
      ),
      env.DB.prepare(
        `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
         VALUES ('user-1', 'pk', 'wrap', 1000, 1000)`,
      ),
      env.DB.prepare(
        `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
         VALUES ('user-1', 'rec', 'draft', 'Y2lwaGVy', 1000, 1)`,
      ),
    ]);

    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind('user-1').run();

    for (const table of ['vault_account', 'vault_passkey_wrap', 'vault_record']) {
      expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results, table).toEqual([]);
    }
  });

  it('carries every existing vault row over the rebuild, and drops the ones whose user is gone', async () => {
    await applyMigrations(env.DB, { through: 6 });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('kept', 'kept', 'kept@example.com', 1, 1000, 1000)`,
      ),
      ...['kept', 'orphan'].flatMap(userId => [
        env.DB.prepare(
          `INSERT INTO vault_account (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
           VALUES (?, 'password', 'wrap', 1000, 2000)`,
        ).bind(userId),
        env.DB.prepare(
          `INSERT INTO vault_passkey_wrap (user_id, passkey_id, wrapped_dek, created_at, updated_at)
           VALUES (?, 'pk', 'wrap', 1000, 2000)`,
        ).bind(userId),
        env.DB.prepare(
          `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
           VALUES (?, 'rec', 'draft', 'Y2lwaGVy', 2000, 7)`,
        ).bind(userId),
        env.DB.prepare(
          `INSERT INTO vault_record (user_id, id, type, ciphertext, updated_at, revision)
           VALUES (?, 'old', 'draft', 'b2xk', 1000, NULL)`,
        ).bind(userId),
      ]),
    ]);

    await applyPendingMigrations(env.DB);

    const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;
    expect(await rows('SELECT * FROM vault_account')).toEqual([
      {
        user_id: 'kept',
        unlock_mode: 'password',
        password_wrapped_dek: 'wrap',
        created_at: 1000,
        updated_at: 2000,
      },
    ]);
    expect(await rows('SELECT * FROM vault_passkey_wrap')).toEqual([
      {
        user_id: 'kept',
        passkey_id: 'pk',
        wrapped_dek: 'wrap',
        created_at: 1000,
        updated_at: 2000,
      },
    ]);
    expect(await rows('SELECT * FROM vault_record ORDER BY id')).toEqual([
      {
        user_id: 'kept',
        id: 'old',
        type: 'draft',
        ciphertext: 'b2xk',
        updated_at: 1000,
        revision: null,
      },
      {
        user_id: 'kept',
        id: 'rec',
        type: 'draft',
        ciphertext: 'Y2lwaGVy',
        updated_at: 2000,
        revision: 7,
      },
    ]);
    expect(
      await rows(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'vault_record_user_type_id'",
      ),
    ).toHaveLength(1);
  });
});
