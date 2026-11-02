import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { describe, expect, it, vi } from 'vitest';
import { createVaultApiClient } from './api';

describe('Vault API client', () => {
  it('gets a record by type and id and validates response schema', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'acc-1',
          type: 'account',
          ciphertext: 'Y2lwaGVyLWFjYy0x',
          updatedAt: 12345,
          revision: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    const result = await client.get('account', 'acc-1');

    expect(result).toEqual({
      id: 'acc-1',
      type: 'account',
      ciphertext: 'Y2lwaGVyLWFjYy0x',
      updatedAt: 12345,
      revision: 1,
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

    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    const result = await client.get('account', 'missing-id');
    expect(result).toBeNull();
  });

  it('paginates list across multiple cursor pages', async () => {
    const page1 = {
      records: [
        { id: '1', type: 'account', ciphertext: 'Y2lwaGVyLTE=', updatedAt: 100, revision: 1 },
        { id: '2', type: 'account', ciphertext: 'Y2lwaGVyLTI=', updatedAt: 101, revision: 1 },
      ],
      nextCursor: 'cursor-page-2',
    };
    const page2 = {
      records: [
        { id: '3', type: 'account', ciphertext: 'Y2lwaGVyLTM=', updatedAt: 102, revision: 1 },
      ],
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

    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
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

    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    await client.put(
      {
        id: 'acc-1',
        type: 'account',
        ciphertext: 'Y2lwaGVyLWFjYy0x',
      },
      1,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/api/v1/vault/records/account/acc-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ ciphertext: 'Y2lwaGVyLWFjYy0x', revision: 1 }),
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

    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    await expect(
      client.put(
        {
          id: 'acc-1',
          type: 'account',
          ciphertext: 'Y2lwaGVyLWFjYy0x',
        },
        1,
      ),
    ).rejects.toMatchObject({
      name: 'VaultApiError',
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('puts a password change to its own route, with the three fields and the account', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    const input = { currentAuthValue: 'a', newAuthValue: 'b', wrappedDek: 'c' };

    await client.changePassword(input);

    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/api/v1/vault/unlock/password');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(new Headers(init?.headers).get(ACCOUNT_HEADER)).toBe('user-123');
  });

  it('removes a passkey by its credential id, URL-encoded, naming the account', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

    await client.removePasskey('cred/with+odd=chars');

    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/api/v1/vault/unlock/passkey/cred%2Fwith%2Bodd%3Dchars');
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get(ACCOUNT_HEADER)).toBe('user-123');
  });

  it('reports the last passkey as a conflict', async () => {
    const mockFetch = vi.fn(async () =>
      Response.json({ error: { code: 'CONFLICT', message: 'last' } }, { status: 409 }),
    );
    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

    await expect(client.removePasskey('cred-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('names its account on every request', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
    const sentAccounts = () =>
      mockFetch.mock.calls.map(([, init]) => new Headers(init?.headers).get(ACCOUNT_HEADER));

    await client.resetVault();
    await client.remove('account', 'acc-1');
    await client.deleteAccount();
    await client.removePasskey('cred-1');

    expect(sentAccounts()).toEqual(['user-123', 'user-123', 'user-123', 'user-123']);
  });

  it('deletes the account with one credentialed DELETE, and reports a stale session as such', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'SESSION_NOT_FRESH', message: 'Sign in again to make this change' } },
          { status: 403 },
        ),
      );
    const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

    await client.deleteAccount();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/api/v1/account',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );

    await expect(client.deleteAccount()).rejects.toMatchObject({
      name: 'VaultApiError',
      code: 'SESSION_NOT_FRESH',
      status: 403,
    });
  });

  describe('files', () => {
    const FILE_ID = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

    it('uploads raw bytes, naming the account', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');
      const bytes = new Uint8Array([1, 2, 3]);

      await client.putFile(FILE_ID, bytes);

      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe(`https://api.test/api/v1/vault/files/${FILE_ID}`);
      expect(init).toMatchObject({ method: 'PUT', body: bytes, credentials: 'include' });
      expect(init.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(init.headers.get(ACCOUNT_HEADER)).toBe('user-123');
    });

    it('reads bytes back, and null for a 404', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 404 }));
      const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

      expect(await client.getFile(FILE_ID)).toEqual(new Uint8Array([9, 8, 7]));
      expect(await client.getFile(FILE_ID)).toBeNull();
    });

    it('names a download cut off mid-body a network error', async () => {
      const cutOff = new ReadableStream({
        start: controller => controller.error(new TypeError('terminated')),
      });
      const mockFetch = vi.fn().mockResolvedValue(new Response(cutOff, { status: 200 }));
      const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

      await expect(client.getFile(FILE_ID)).rejects.toMatchObject({
        name: 'VaultApiError',
        code: 'NETWORK_ERROR',
      });
    });

    it('names a refused upload by its code', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'STORAGE_FULL', message: 'Full' } }), {
          status: 413,
        }),
      );
      const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

      await expect(client.putFile(FILE_ID, new Uint8Array([1]))).rejects.toMatchObject({
        code: 'STORAGE_FULL',
        status: 413,
      });
    });

    it('lists a page after a cursor, and removes', async () => {
      const page = { files: [], nextCursor: null, usedBytes: 0, capBytes: 1024 };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
      const client = createVaultApiClient('https://api.test', mockFetch).forAccount('user-123');

      expect(await client.listFiles(FILE_ID)).toEqual(page);
      await client.removeFile(FILE_ID);

      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        `https://api.test/api/v1/vault/files?after=${FILE_ID}`,
      );
      expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    });
  });
});
