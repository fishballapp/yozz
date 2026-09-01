import 'fake-indexeddb/auto';
import type { UnlockStatusResponse } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultApiClient } from './api.ts';
import {
  addPasskeyToSession,
  createPasskeyVault,
  createPasswordVault,
  loginWithPasskey,
  loginWithPassword,
  switchModeToPasskey,
  switchModeToPassword,
} from './unlock.ts';

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('./auth-client.ts', () => ({
  signInWithPassword: mocks.signInEmail,
  signInWithPasskey: mocks.signInPasskey,
  addPasskeyAuthenticator: mocks.addPasskey,
  deletePasskeyAuthenticator: mocks.deletePasskey,
  getSession: mocks.getSession,
}));

vi.mock('./passkey-prf.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./passkey-prf.ts')>();
  return {
    ...actual,
    checkPasskeyPrfCapability: vi.fn().mockResolvedValue('supported'),
  };
});

const createMockVaultApi = (): VaultApiClient => {
  let mode: 'password' | 'passkey' | null = null;
  let wrappedDek = '';
  const passkeyWraps = new Map<string, string>();

  return {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockReturnValue((async function* () {})()),
    put: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getUnlockStatus: vi.fn().mockImplementation(async (): Promise<UnlockStatusResponse> => {
      if (mode === 'password') {
        return { mode: 'password', wrappedDek, updatedAt: 1000 };
      }
      if (mode === 'passkey') {
        return {
          mode: 'passkey',
          passkeys: [{ passkeyId: 'pk-registered-id', createdAt: 1000 }],
        };
      }
      return { mode: null };
    }),
    getPasskeyWrap: vi.fn().mockImplementation(async (credId: string) => {
      // The wrap is stored under the WebAuthn credential id, so Better Auth's row id must fail.
      const wrap = passkeyWraps.get(credId);
      if (!wrap) throw new Error(`no wrap for credential ${credId}`);
      return wrap;
    }),
    finalizePasswordUnlock: vi
      .fn()
      .mockImplementation(async (input: { isNewVault: boolean; wrappedDek: string }) => {
        if (input.isNewVault && mode !== null) throw new Error('409 CONFLICT');
        mode = 'password';
        wrappedDek = input.wrappedDek;
      }),
    finalizePasskeyUnlock: vi
      .fn()
      .mockImplementation(
        async (input: { isNewVault: boolean; credentialId: string; wrappedDek: string }) => {
          if (input.isNewVault && mode !== null) throw new Error('409 CONFLICT');
          mode = 'passkey';
          wrappedDek = input.wrappedDek;
          passkeyWraps.set(input.credentialId, input.wrappedDek);
        },
      ),
    resetVault: vi.fn().mockImplementation(async () => {
      mode = null;
      wrappedDek = '';
      passkeyWraps.clear();
    }),
  };
};

/** Two ceremonies: `create()` reports `enabled`, then a `get()` pinned to that credential produces the bytes. */
const mockPrfAssertion = (expectedCredentialId: string, prfBytes: Uint8Array) => {
  const get = vi.fn(async (options: CredentialRequestOptions) => {
    const allow = options.publicKey?.allowCredentials ?? [];
    expect(allow).toHaveLength(1);
    expect(new Uint8Array(allow[0]?.id as ArrayBuffer).toBase64({ alphabet: 'base64url' })).toBe(
      expectedCredentialId,
    );
    return {
      getClientExtensionResults: () => ({ prf: { results: { first: prfBytes.buffer } } }),
    } as unknown as Credential;
  });
  vi.stubGlobal('navigator', { credentials: { get } });
  return get;
};

describe('Vault unlock and session orchestration', () => {
  let idbFactory: IDBFactory;
  let api: VaultApiClient;

  beforeEach(() => {
    idbFactory = new IDBFactory();
    api = createMockVaultApi();
    vi.clearAllMocks();

    mocks.getSession.mockResolvedValue({
      data: {
        user: { id: 'user-123', email: 'alice@example.com' },
      },
    });
    mocks.signInEmail.mockResolvedValue({ data: { user: { id: 'user-123' } } });
  });

  it('creates and unlocks a password vault from the password alone', async () => {
    const session = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });

    expect(session.userId).toBe('user-123');
    expect(session.email).toBe('alice@example.com');
    expect(session.mode).toBe('password');
    expect(session.wrappedDek).toBeTypeOf('string');
    // Credential and mode are finalised in one call carrying `authValue`; `/api/auth/set-password` is not mounted.
    expect(api.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
    const [sent] = vi.mocked(api.finalizePasswordUnlock).mock.calls[0] ?? [];
    expect(sent?.isNewVault).toBe(true);
    expect(sent?.wrappedDek).toBe(session.wrappedDek);
    expect(sent?.authValue).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // Only the derived authValue leaves the browser.
    expect(sent?.authValue).not.toBe('password123456');

    const loginSession = await loginWithPassword({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });

    expect(loginSession.userId).toBe('user-123');
    expect(loginSession.mode).toBe('password');

    session.store.close();
    loginSession.store.close();
  });

  it('creates and unlocks passkey vault with PRF extension', async () => {
    const dummyPrfBytes = new Uint8Array(32).fill(99);
    // The real Better Auth shape: `data` is the passkey row, the WebAuthn half is under `webauthn`,
    // and registration reports `enabled` with no results.
    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-row-id' },
      webauthn: {
        response: { id: 'pk-registered-id' },
        clientExtensionResults: { prf: { enabled: true } },
      },
    });
    const prfGet = mockPrfAssertion('pk-registered-id', dummyPrfBytes);

    const session = await createPasskeyVault({
      api,
      idbFactory,
    });

    expect(session.mode).toBe('passkey');
    expect(prfGet).toHaveBeenCalledTimes(1);
    expect(api.finalizePasskeyUnlock).toHaveBeenCalledWith({
      isNewVault: true,
      credentialId: 'pk-registered-id',
      wrappedDek: session.wrappedDek,
    });

    mocks.signInPasskey.mockResolvedValue({
      data: { session: {}, user: { id: 'user-123' } },
      webauthn: {
        response: { id: 'pk-registered-id' },
        clientExtensionResults: {
          prf: {
            results: { first: dummyPrfBytes.buffer },
          },
        },
      },
    });

    const loginSession = await loginWithPasskey({
      api,
      idbFactory,
    });

    expect(loginSession.mode).toBe('passkey');
    expect(loginSession.userId).toBe('user-123');

    session.store.close();
    loginSession.store.close();
  });

  it('reports a provisional passkey it could not clean up, rather than only the cause', async () => {
    // Enrolment must fail and remove the credential; if that also fails, the caller has to be told.
    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-row' },
      webauthn: {
        response: { id: 'pk-orphan' },
        clientExtensionResults: { prf: { enabled: false } },
      },
    });
    mocks.deletePasskey.mockResolvedValue({ error: { message: 'network down' } });

    await expect(createPasskeyVault({ api, idbFactory })).rejects.toThrow(/could not be removed/);
    // The row id: `/passkey/delete-passkey` resolves `where: [{ field: 'id' }]`.
    expect(mocks.deletePasskey).toHaveBeenCalledWith('pk-row');
  });

  it('refuses to create a second vault over an enrolled account, which would strand every record', async () => {
    // `createVault()` mints a fresh DEK, and the server cannot tell a new DEK from a rewrap.
    const pw = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });
    pw.store.close();

    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-row-2' },
      webauthn: {
        response: { id: 'pk-cred-2' },
        clientExtensionResults: { prf: { enabled: true } },
      },
    });

    await expect(createPasskeyVault({ api, idbFactory })).rejects.toThrow(
      /already has a password vault/,
    );
    // Before registering anything.
    expect(mocks.addPasskey).not.toHaveBeenCalled();
  });

  it('refuses addPasskeyToSession from a password session — that is a mode switch', async () => {
    // The finalisation nulls the password wrap; from a password session the next reload could not unlock.
    const pw = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });

    await expect(addPasskeyToSession({ currentSession: pw, api })).rejects.toThrow(
      /use switchModeToPasskey/,
    );
    expect(mocks.addPasskey).not.toHaveBeenCalled();
    pw.store.close();
  });

  it('switches mode between password and passkey while re-wrapping DEK seamlessly', async () => {
    const dummyPrfBytes = new Uint8Array(32).fill(77);
    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-switch-row-id' },
      webauthn: {
        response: { id: 'pk-switch-id' },
        clientExtensionResults: { prf: { enabled: true } },
      },
    });
    mockPrfAssertion('pk-switch-id', dummyPrfBytes);

    const pwSession = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });

    await pwSession.store.put({
      type: 'account',
      naturalKey: 'bank-acc',
      plaintext: 'Bank Details',
    });

    const pkSession = await switchModeToPasskey({
      currentSession: pwSession,
      api,
    });

    expect(pkSession.mode).toBe('passkey');
    expect(api.finalizePasskeyUnlock).toHaveBeenCalled();

    const pwSession2 = await switchModeToPassword({
      currentSession: pkSession,
      password: 'newpassword456789',
      api,
    });

    expect(pwSession2.mode).toBe('password');
    expect(api.finalizePasswordUnlock).toHaveBeenCalled();

    pwSession.store.close();
  });
});

describe('createPasswordVault with a short password', () => {
  it('refuses before touching the server or the key schedule', async () => {
    const api = createMockVaultApi();
    await expect(
      createPasswordVault({
        email: 'a@b.c',
        password: 'short',
        api,
        idbFactory: new IDBFactory(),
      }),
    ).rejects.toThrow(/at least 12 characters/);
    expect(api.getUnlockStatus).not.toHaveBeenCalled();
    expect(api.finalizePasswordUnlock).not.toHaveBeenCalled();
  });
});

describe('createPasswordVault over an enrolled account', () => {
  it('refuses before deriving anything, for the same reason the passkey path does', async () => {
    const api = createMockVaultApi();
    const idbFactory = new IDBFactory();
    mocks.getSession.mockResolvedValue({
      data: { user: { id: 'user-123', email: 'alice@example.com' } },
    });

    const first = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123456',
      api,
      idbFactory,
    });
    first.store.close();

    await expect(
      createPasswordVault({
        email: 'alice@example.com',
        password: 'another-password',
        api,
        idbFactory,
      }),
    ).rejects.toThrow(/already has a password vault/);
    expect(api.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
  });
});
