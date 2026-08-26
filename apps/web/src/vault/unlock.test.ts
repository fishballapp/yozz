import 'fake-indexeddb/auto';
import type { UnlockStatusResponse } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultApiClient } from './api.ts';
import { DeviceSecretMissingError } from './device-secret.ts';
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

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

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
      // No fallback. The wrap is stored under the WebAuthn CREDENTIAL id, so
      // looking it up with Better Auth's internal row id must fail rather than
      // quietly returning the current wrap and hiding the mix-up.
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

/**
 * Enrolment is TWO ceremonies now: `create()` associates the PRF key and
 * reports `enabled`, then a scoped local `get()` produces the bytes. The mock
 * asserts the assertion is pinned to the credential just registered — an
 * unscoped one would let a different passkey answer, and the DEK would be
 * wrapped under the wrong authenticator.
 */
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
  let storage: MockStorage;
  let api: VaultApiClient;

  beforeEach(() => {
    idbFactory = new IDBFactory();
    storage = new MockStorage();
    api = createMockVaultApi();
    vi.clearAllMocks();

    mocks.getSession.mockResolvedValue({
      data: {
        user: { id: 'user-123', email: 'alice@example.com' },
      },
    });
    mocks.signInEmail.mockResolvedValue({ data: { user: { id: 'user-123' } } });
  });

  it('creates and unlocks password vault, saving device secret to localStorage', async () => {
    const session = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
    });

    expect(session.userId).toBe('user-123');
    expect(session.email).toBe('alice@example.com');
    expect(session.mode).toBe('password');
    expect(session.wrappedDek).toBeTypeOf('string');
    /**
     * The credential and the mode are finalised in ONE server call, carrying
     * `authValue`. An earlier version called a separate `setAccountPassword`
     * that hit `/api/auth/set-password` — a route Better Auth does not mount,
     * because `setPassword` is `serverOnly` — ignored the 404, and finalised a
     * vault whose password credential did not exist. Mocking that call is what
     * made the broken path green, so asserting the payload here is the point.
     */
    expect(api.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
    const [sent] = vi.mocked(api.finalizePasswordUnlock).mock.calls[0] ?? [];
    expect(sent?.isNewVault).toBe(true);
    expect(sent?.wrappedDek).toBe(session.wrappedDek);
    expect(sent?.authValue).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // The password itself never leaves the browser — only its derived authValue.
    expect(sent?.authValue).not.toBe('password123');

    // Logging in on the same device with existing storage succeeds
    const loginSession = await loginWithPassword({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
    });

    expect(loginSession.userId).toBe('user-123');
    expect(loginSession.mode).toBe('password');

    session.store.close();
    loginSession.store.close();
  });

  it('throws DeviceSecretMissingError when password login is attempted without local secret', async () => {
    const emptyStorage = new MockStorage();

    await expect(
      loginWithPassword({
        email: 'alice@example.com',
        password: 'password123',
        api,
        idbFactory,
        storage: emptyStorage,
      }),
    ).rejects.toThrow(DeviceSecretMissingError);
  });

  it('creates and unlocks passkey vault with PRF extension', async () => {
    const dummyPrfBytes = new Uint8Array(32).fill(99);
    /**
     * The REAL Better Auth shape: `data` is the persisted passkey row, and the
     * WebAuthn half — credential id and extension results — is under `webauthn`.
     * Registration reports `enabled` and NO results, which is what `create()`
     * actually returns. Mocking `clientExtensionResults` under `data`, as an
     * earlier version did, reproduced the code's assumption instead of the
     * plugin's contract and hid the fact that PRF never ran at all.
     */
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

    // Login with passkey
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
    // The authenticator cannot do PRF, so enrolment must fail AND remove the
    // credential it just made. When the removal also fails, an orphan stays in
    // the user's chooser and will be refused at sign-in for having no wrap —
    // which reads as "my passkey stopped working". The caller has to be told.
    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-row' },
      webauthn: {
        response: { id: 'pk-orphan' },
        clientExtensionResults: { prf: { enabled: false } },
      },
    });
    mocks.deletePasskey.mockResolvedValue({ error: { message: 'network down' } });

    await expect(createPasskeyVault({ api, idbFactory })).rejects.toThrow(/could not be removed/);
    // The ROW id, not the credential id. `/passkey/delete-passkey` resolves
    // `where: [{ field: 'id' }]`, so addressing it with `pk-orphan` would delete
    // nothing and then report a failure that never happened.
    expect(mocks.deletePasskey).toHaveBeenCalledWith('pk-row');
  });

  it('refuses to create a second vault over an enrolled account, which would strand every record', async () => {
    // `createVault()` mints a FRESH DEK and finalisation upserts the wrap, so
    // running a create against an enrolled account silently rebinds the account
    // to a key that opens none of its ciphertext. The server cannot tell a new
    // DEK from a rewrap — both are opaque wrapped bytes — so the guard is here.
    const pw = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
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
    // It must refuse BEFORE registering anything.
    expect(mocks.addPasskey).not.toHaveBeenCalled();
  });

  it('refuses addPasskeyToSession from a password session — that is a mode switch', async () => {
    // The finalisation it calls nulls the password wrap and deletes the
    // credential row. From a password session that is a silent mode change the
    // in-memory session would keep reporting as `password`, and the next reload
    // could not unlock.
    const pw = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
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

    // Start in password mode
    const pwSession = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
    });

    // Write a secret record
    await pwSession.store.put({
      type: 'account',
      naturalKey: 'bank-acc',
      plaintext: 'Bank Details',
    });

    // Switch to passkey mode
    const pkSession = await switchModeToPasskey({
      currentSession: pwSession,
      api,
    });

    expect(pkSession.mode).toBe('passkey');
    expect(api.finalizePasskeyUnlock).toHaveBeenCalled();

    // Switch back to password mode
    const pwSession2 = await switchModeToPassword({
      currentSession: pkSession,
      password: 'newpassword456',
      api,
      storage,
    });

    expect(pwSession2.mode).toBe('password');
    expect(api.finalizePasswordUnlock).toHaveBeenCalled();

    pwSession.store.close();
  });
});

describe('createPasswordVault with a short password', () => {
  it('refuses before touching the device secret, the server or the key schedule', async () => {
    const api = createMockVaultApi();
    await expect(
      createPasswordVault({
        email: 'a@b.c',
        password: 'short',
        api,
        idbFactory: new IDBFactory(),
        storage: new MockStorage(),
      }),
    ).rejects.toThrow(/at least 8 characters/);
    expect(api.getUnlockStatus).not.toHaveBeenCalled();
    expect(api.finalizePasswordUnlock).not.toHaveBeenCalled();
  });
});

describe('createPasswordVault over an enrolled account', () => {
  it('refuses before deriving anything, for the same reason the passkey path does', async () => {
    const api = createMockVaultApi();
    const storage = new MockStorage();
    const idbFactory = new IDBFactory();
    mocks.getSession.mockResolvedValue({
      data: { user: { id: 'user-123', email: 'alice@example.com' } },
    });

    const first = await createPasswordVault({
      email: 'alice@example.com',
      password: 'password123',
      api,
      idbFactory,
      storage,
    });
    first.store.close();

    await expect(
      createPasswordVault({
        email: 'alice@example.com',
        password: 'another-password',
        api,
        idbFactory,
        storage,
      }),
    ).rejects.toThrow(/already has a password vault/);
    expect(api.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
  });
});
