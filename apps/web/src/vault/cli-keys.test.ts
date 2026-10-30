import { VaultApiError } from '@yozz.app/mail/vault/api';
import {
  createVault,
  deriveCliKeys,
  generateCliKeyPair,
  openCliLogin,
  openVault,
  pairingCode,
} from '@yozz.app/vault';
import { CliLoginCallbackSchema, type CreateCliKeyRequest } from '@yozz.app/vault-contract';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountVaultApi, VaultApiClient } from './api';
import {
  approveCliLogin,
  cliCallbackUrl,
  listCliKeys,
  parseCliApproveQuery,
  revokeCliKey,
} from './cli-keys';
import type { UnlockedVaultSession } from './unlock';

const STATE = 'S'.repeat(43);
const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TOKEN = `yozzcli_${KEY_ID}_${'A'.repeat(43)}`;

/** A real public key: the schema only takes one spelling of 32 bytes. */
let publicKey: string;
let privateKey: string;
beforeAll(async () => {
  ({ publicKey, privateKey } = await generateCliKeyPair());
});

const linkQuery = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({ port: '53682', state: STATE, publicKey, name: 'jasons-mbp', ...overrides });

/** Only the account calls a test names are answered. */
const apiWith = (calls: Partial<AccountVaultApi>): VaultApiClient => ({
  forAccount: () => calls as AccountVaultApi,
});

describe('parseCliApproveQuery', () => {
  it('reads the four parts yozz login writes, with or without the leading ?', () => {
    const expected = { port: 53682, state: STATE, publicKey, name: 'jasons-mbp' };
    expect(parseCliApproveQuery(linkQuery().toString())).toEqual(expected);
    expect(parseCliApproveQuery(`?${linkQuery()}`)).toEqual(expected);
  });

  it('keeps a name that looks like a number a string', () => {
    expect(parseCliApproveQuery(linkQuery({ name: '1234' }).toString())?.name).toBe('1234');
  });

  it.each([
    ['no state', () => linkQuery({ state: '' })],
    ['a short state', () => linkQuery({ state: 'S'.repeat(42) })],
    ['a privileged port', () => linkQuery({ port: '80' })],
    ['a port that is not a number', () => linkQuery({ port: 'http' })],
    ['a key that is not 32 bytes', () => linkQuery({ publicKey: 'A'.repeat(42) })],
    ['a blank name', () => linkQuery({ name: '   ' })],
    ['a part it does not know', () => linkQuery({ host: 'evil.example' })],
  ])('refuses a link with %s', (_, query) => {
    expect(parseCliApproveQuery(query().toString())).toBeNull();
  });

  it('refuses a link with no query at all', () => {
    expect(parseCliApproveQuery('')).toBeNull();
  });
});

describe('cliCallbackUrl', () => {
  it('names the loopback address, the port and the callback, and nothing else', () => {
    const url = new URL(cliCallbackUrl(53682, { state: STATE, error: 'denied' }));
    expect(url.origin).toBe('http://127.0.0.1:53682');
    expect(url.pathname).toBe('/callback');
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: STATE, error: 'denied' });
  });

  it('carries base64 through the query intact', () => {
    const sealedLogin = 'a+b/c==';
    const url = new URL(
      cliCallbackUrl(53682, { state: STATE, ephemeralPublicKey: publicKey, sealedLogin }),
    );
    expect(CliLoginCallbackSchema.parse(Object.fromEntries(url.searchParams))).toEqual({
      state: STATE,
      ephemeralPublicKey: publicKey,
      sealedLogin,
    });
  });
});

describe('approveCliLogin', () => {
  const sessionWithVault = async (): Promise<UnlockedVaultSession> => {
    const encKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'wrapKey',
      'unwrapKey',
    ]);
    const { vault, wrappedDek } = await createVault({ encKey });
    return {
      userId: 'user-1',
      email: 'jason@example.com',
      mode: 'password',
      encKey,
      wrappedDek,
      vault,
      store: {} as UnlockedVaultSession['store'],
    };
  };

  it('hands the CLI a login only it can open, and a wrap that opens the same vault', async () => {
    const session = await sessionWithVault();
    const createCliKey = vi.fn(async (_: CreateCliKeyRequest) => ({ keyId: KEY_ID, token: TOKEN }));
    const query = { port: 53682, state: STATE, publicKey, name: 'jasons-mbp' };

    const approved = await approveCliLogin({
      session,
      query,
      isCurrent: () => true,
      api: apiWith({ createCliKey }),
    });
    if (approved.outcome !== 'approved') throw new Error('the approval ended');

    const request = createCliKey.mock.calls[0]?.[0];
    if (request === undefined) throw new Error('no CLI key was created');
    expect(request.name).toBe('jasons-mbp');
    expect(request.publicKey).toBe(publicKey);

    const url = new URL(approved.callbackUrl);
    expect(url.origin).toBe('http://127.0.0.1:53682');
    const callback = CliLoginCallbackSchema.parse(Object.fromEntries(url.searchParams));
    if (!('sealedLogin' in callback)) throw new Error('the callback was a denial');
    expect(callback.ephemeralPublicKey).toBe(request.ephemeralPublicKey);

    // The CLI's side, from its private key alone.
    const keys = await deriveCliKeys({
      privateKey,
      ephemeralPublicKey: callback.ephemeralPublicKey,
    });
    expect(
      await openCliLogin(keys.tokenKey, { state: STATE, sealedLogin: callback.sealedLogin }),
    ).toEqual({
      token: TOKEN,
      userId: 'user-1',
      email: 'jason@example.com',
    });
    const cliVault = await openVault(keys, request.wrappedDek);
    const record = await session.vault.encryptRecord({
      type: 'account',
      naturalKey: 'imap.example.com',
      revision: 1,
      plaintext: 'secret',
    });
    expect(
      (
        await cliVault.decryptRecord({
          type: 'account',
          naturalKey: 'imap.example.com',
          ciphertext: record.ciphertext,
        })
      ).plaintext,
    ).toBe('secret');

    // Sealed to this login's state: a callback replayed into another login does not open.
    await expect(
      openCliLogin(keys.tokenKey, { state: 'T'.repeat(43), sealedLogin: callback.sealedLogin }),
    ).rejects.toThrow();
  });

  it('mints nothing for a session the tab closed while the wrap was made', async () => {
    const createCliKey = vi.fn();
    const approved = await approveCliLogin({
      session: await sessionWithVault(),
      query: { port: 53682, state: STATE, publicKey, name: 'jasons-mbp' },
      isCurrent: () => false,
      api: apiWith({ createCliKey }),
    });
    expect(approved).toEqual({ outcome: 'ended' });
    expect(createCliKey).not.toHaveBeenCalled();
  });

  it('says plainly when the account has no vault to open', async () => {
    const approval = approveCliLogin({
      session: await sessionWithVault(),
      query: { port: 53682, state: STATE, publicKey, name: 'jasons-mbp' },
      isCurrent: () => true,
      api: apiWith({
        createCliKey: async () => {
          throw new VaultApiError('CONFLICT', 'This account has no vault to open', 409);
        },
      }),
    });
    await expect(approval).rejects.toThrow('This account has no vault to open.');
  });
});

describe('listCliKeys', () => {
  it('computes each key’s pairing code from its public key, in the Worker’s order', async () => {
    const other = (await generateCliKeyPair()).publicKey;
    const summary = { name: 'laptop', createdAt: 1, lastUsedAt: null };
    const keys = await listCliKeys(
      'user-1',
      apiWith({
        listCliKeys: async () => [
          { ...summary, keyId: KEY_ID, publicKey },
          { ...summary, keyId: crypto.randomUUID(), publicKey: other, createdAt: 2 },
        ],
      }),
    );
    expect(keys.map(key => key.pairingCode)).toEqual([
      await pairingCode(publicKey),
      await pairingCode(other),
    ]);
  });
});

describe('revokeCliKey', () => {
  it('says a key already gone is gone', async () => {
    const revocation = revokeCliKey({
      userId: 'user-1',
      keyId: KEY_ID,
      api: apiWith({
        revokeCliKey: async () => {
          throw new VaultApiError('NOT_FOUND', 'CLI key not found', 404);
        },
      }),
    });
    await expect(revocation).rejects.toThrow('That key is already revoked.');
  });
});
