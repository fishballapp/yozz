import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations.ts';

describe('D1 migrations and schema invariants', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
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

  it('app tables have no foreign keys coupling them to Better Auth tables', async () => {
    const recordFk = await env.DB.prepare('PRAGMA foreign_key_list(vault_record)').all();
    const accountFk = await env.DB.prepare('PRAGMA foreign_key_list(vault_account)').all();
    const passkeyWrapFk = await env.DB.prepare('PRAGMA foreign_key_list(vault_passkey_wrap)').all();

    expect(recordFk.results).toEqual([]);
    expect(accountFk.results).toEqual([]);
    expect(passkeyWrapFk.results).toEqual([]);
  });
});
