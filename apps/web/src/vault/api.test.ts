import { describe, expect, it, vi } from 'vitest';
import { createVaultApiClient } from './api.ts';

describe('Vault API client', () => {
  it('gets a record by type and id and validates response schema', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'acc-1',
          type: 'account',
          ciphertext: 'Y2lwaGVyLWFjYy0x',
          updatedAt: 12345,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = createVaultApiClient('https://api.test', mockFetch);
    const result = await client.get('account', 'acc-1');

    expect(result).toEqual({
      id: 'acc-1',
      type: 'account',
      ciphertext: 'Y2lwaGVyLWFjYy0x',
      updatedAt: 12345,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/api/v1/vault/records/account/acc-1',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('returns null on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createVaultApiClient('https://api.test', mockFetch);
    const result = await client.get('account', 'missing-id');
    expect(result).toBeNull();
  });

  it('paginates list across multiple cursor pages', async () => {
    const page1 = {
      records: [
        { id: '1', type: 'account', ciphertext: 'Y2lwaGVyLTE=', updatedAt: 100 },
        { id: '2', type: 'account', ciphertext: 'Y2lwaGVyLTI=', updatedAt: 101 },
      ],
      nextCursor: 'cursor-page-2',
    };
    const page2 = {
      records: [{ id: '3', type: 'account', ciphertext: 'Y2lwaGVyLTM=', updatedAt: 102 }],
      nextCursor: null,
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page1), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = createVaultApiClient('https://api.test', mockFetch);
    const collected: unknown[] = [];
    for await (const record of client.list('account')) {
      collected.push(record);
    }

    expect(collected).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.test/api/v1/vault/records/account',
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.test/api/v1/vault/records/account?after=cursor-page-2',
      expect.anything(),
    );
  });

  it('puts a record with serialized ciphertext payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createVaultApiClient('https://api.test', mockFetch);
    await client.put({
      id: 'acc-1',
      type: 'account',
      ciphertext: 'Y2lwaGVyLWFjYy0x',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/api/v1/vault/records/account/acc-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWFjYy0x' }),
      }),
    );
  });

  it('maps server error responses to typed VaultApiError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'CONFLICT',
            message: 'Record exists with different type',
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = createVaultApiClient('https://api.test', mockFetch);
    await expect(
      client.put({
        id: 'acc-1',
        type: 'account',
        ciphertext: 'Y2lwaGVyLWFjYy0x',
      }),
    ).rejects.toMatchObject({
      name: 'VaultApiError',
      code: 'CONFLICT',
      status: 409,
    });
  });
});
