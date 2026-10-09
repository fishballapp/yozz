import 'fake-indexeddb/auto';
import type { UnlockStatusResponse } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AccountVaultApi, type VaultApiClient, VaultApiError } from './api';
import {
  addPasskeyToSession,
  confirmIdentity,
  createPasskeyVault,
  createPasswordVault,
  loginWithPasskey,
  loginWithPassword,
  needsFreshSession,
  PASSKEY_DERIVES_ANOTHER_KEY,
  resumeSession,
  switchModeToPasskey,
  switchModeToPassword,
  unlockKeysOf,
} from './unlock';
import { loadUnlockKeys, saveUnlockKeys } from './unlock-keys';

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('./auth-client', () => ({
  signInWithPassword: mocks.signInEmail,
  signInWithPasskey: mocks.signInPasskey,
  addPasskeyAuthenticator: mocks.addPasskey,
  deletePasskeyAuthenticator: mocks.deletePasskey,
  getSession: mocks.getSession,
}));

vi.mock('./passkey-prf', async importOriginal => {
  const actual = await importOriginal<typeof import('./passkey-prf')>();
  return {
    ...actual,
    checkPasskeyPrfCapability: vi.fn().mockResolvedValue('supported'),
  };
});

const ALICE = { userId: 'user-123', email: 'alice@example.com' };
const BOB = { userId: 'user-bob', email: 'bob@example.com' };
/** As Better Auth answers a sign-in or a session read. */
const userOf = ({ userId, email }: typeof ALICE) => ({ id: userId, email });

type AccountCall = keyof AccountVaultApi;

/**
 * The Worker as one browser sees it: a vault per account, and one cookie naming whoever signed in
 * last, in any tab. A client named for anyone else is refused, as the Worker refuses it.
 */
const createMockWorker = () => {
  let cookie: typeof ALICE | null = ALICE;
  const afterAnswers = new Map<AccountCall, () => void>();

  const createVault = (account: typeof ALICE): AccountVaultApi => {
    let mode: 'password' | 'passkey' | null = null;
    let wrappedDek = '';
    const passkeyWraps = new Map<string, string>();

    const answer = async <T>(call: AccountCall, run: () => T): Promise<T> => {
      if (cookie?.userId !== account.userId) {
        throw new VaultApiError('ACCOUNT_MISMATCH', 'Signed in to another account', 403);
      }
      const result = run();
      afterAnswers.get(call)?.();
      afterAnswers.delete(call);
      return result;
    };

    return {
      get: vi.fn(async () => answer('get', () => null)),
      list: vi.fn(() => (async function* () {})()),
      put: vi.fn(async () => answer('put', () => undefined)),
      remove: vi.fn(async () => answer('remove', () => undefined)),
      getUnlockStatus: vi.fn(async () =>
        answer('getUnlockStatus', (): UnlockStatusResponse => {
          if (mode === 'password') return { mode: 'password', wrappedDek, updatedAt: 1000 };
          if (mode === 'passkey') {
            return {
              mode: 'passkey',
              passkeys: [...passkeyWraps.keys()].map(passkeyId => ({ passkeyId, createdAt: 1000 })),
            };
          }
          return { mode: null };
        }),
      ),
      getPasskeyWrap: vi.fn(async (credentialId: string) =>
        answer('getPasskeyWrap', () => {
          // The wrap is stored under the WebAuthn credential id, so Better Auth's row id must fail.
          const wrap = passkeyWraps.get(credentialId);
          if (!wrap) throw new Error(`no wrap for credential ${credentialId}`);
          return wrap;
        }),
      ),
      finalizePasswordUnlock: vi.fn(async (input: { isNewVault: boolean; wrappedDek: string }) =>
        answer('finalizePasswordUnlock', () => {
          if (input.isNewVault && mode !== null) throw new Error('409 CONFLICT');
          mode = 'password';
          wrappedDek = input.wrappedDek;
          passkeyWraps.clear();
        }),
      ),
      finalizePasskeyUnlock: vi.fn(
        async (input: { isNewVault: boolean; credentialId: string; wrappedDek: string }) =>
          answer('finalizePasskeyUnlock', () => {
            if (input.isNewVault && mode !== null) throw new Error('409 CONFLICT');
            mode = 'passkey';
            wrappedDek = input.wrappedDek;
            passkeyWraps.set(input.credentialId, input.wrappedDek);
          }),
      ),
      resetVault: vi.fn(async () =>
        answer('resetVault', () => {
          mode = null;
          wrappedDek = '';
          passkeyWraps.clear();
        }),
      ),
    };
  };

  const vaults = new Map([ALICE, BOB].map(account => [account.userId, createVault(account)]));
  const vaultOf = (userId: string): AccountVaultApi => {
    const vault = vaults.get(userId);
    if (vault === undefined) throw new Error(`no account ${userId}`);
    return vault;
  };

  return {
    api: { forAccount: vi.fn(vaultOf) } satisfies VaultApiClient,
    /** The same client `api.forAccount` hands out, without counting as a call to it. */
    vaultOf,
    signInAs: (account: typeof ALICE | null) => {
      cookie = account;
    },
    /** What `getSession` reads: the cookie, as it is now. */
    session: () => ({ data: cookie === null ? null : { user: userOf(cookie) } }),
    /** Runs `effect` once, right after the server answers the next `call`. */
    afterAnswer: (call: AccountCall, effect: () => void) => {
      afterAnswers.set(call, effect);
    },
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
  let worker: ReturnType<typeof createMockWorker>;
  let api: VaultApiClient;
  let alice: AccountVaultApi;

  beforeEach(() => {
    idbFactory = new IDBFactory();
    worker = createMockWorker();
    api = worker.api;
    alice = worker.vaultOf(ALICE.userId);
    vi.clearAllMocks();

    mocks.getSession.mockImplementation(async () => worker.session());
    mocks.signInEmail.mockImplementation(async (email: string) => {
      const account = email === BOB.email ? BOB : ALICE;
      worker.signInAs(account);
      return { data: { user: userOf(account) }, error: null };
    });
  });

  it('creates and unlocks a password vault from the password alone', async () => {
    const session = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });

    expect(session.userId).toBe('user-123');
    expect(session.email).toBe('alice@example.com');
    expect(session.mode).toBe('password');
    expect(session.wrappedDek).toBeTypeOf('string');
    // Credential and mode are finalised in one call carrying `authValue`; `/api/auth/set-password` is not mounted.
    expect(alice.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
    const [sent] = vi.mocked(alice.finalizePasswordUnlock).mock.calls[0] ?? [];
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
      account: ALICE,
      api,
      idbFactory,
    });

    expect(session.mode).toBe('passkey');
    expect(prfGet).toHaveBeenCalledTimes(1);
    expect(alice.finalizePasskeyUnlock).toHaveBeenCalledWith({
      isNewVault: true,
      credentialId: 'pk-registered-id',
      wrappedDek: session.wrappedDek,
    });

    mocks.signInPasskey.mockResolvedValue({
      data: { session: {}, user: userOf(ALICE) },
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

  describe('a login another tab signs in under', () => {
    const RECORD = { type: 'account', naturalKey: 'imap.example.com', plaintext: 'Alice’s' };

    /** Alice's keys are this tab's whatever the cookie says now, so its writes must reach Alice only. */
    const expectBoundToAlice = async (session: Awaited<ReturnType<typeof loginWithPassword>>) => {
      expect(session).toMatchObject({ userId: ALICE.userId, email: ALICE.email });
      await expect(session.store.put(RECORD)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
      expect(api.forAccount).not.toHaveBeenCalledWith(BOB.userId);
      session.store.close();
    };

    it('opens a password login for the account that signed in, not the cookie’s', async () => {
      (
        await createPasswordVault({ account: ALICE, password: 'password123456', api, idbFactory })
      ).store.close();
      vi.mocked(api.forAccount).mockClear();
      worker.afterAnswer('getUnlockStatus', () => worker.signInAs(BOB));

      await expectBoundToAlice(
        await loginWithPassword({
          email: ALICE.email,
          password: 'password123456',
          api,
          idbFactory,
        }),
      );
    });

    it('opens a passkey login for the account that signed in, not the cookie’s', async () => {
      const prfBytes = new Uint8Array(32).fill(42);
      mocks.addPasskey.mockResolvedValue({
        data: { id: 'pk-row-id' },
        webauthn: {
          response: { id: 'pk-registered-id' },
          clientExtensionResults: { prf: { enabled: true } },
        },
      });
      mockPrfAssertion('pk-registered-id', prfBytes);
      (await createPasskeyVault({ account: ALICE, api, idbFactory })).store.close();
      vi.mocked(api.forAccount).mockClear();
      mocks.signInPasskey.mockImplementationOnce(async () => {
        worker.signInAs(ALICE);
        return {
          data: { session: {}, user: userOf(ALICE) },
          webauthn: {
            response: { id: 'pk-registered-id' },
            clientExtensionResults: { prf: { results: { first: prfBytes.buffer } } },
          },
        };
      });
      worker.afterAnswer('getPasskeyWrap', () => worker.signInAs(BOB));

      await expectBoundToAlice(await loginWithPasskey({ api, idbFactory }));
    });
  });

  it('says a synced passkey derived another key here, rather than blaming a passphrase', async () => {
    mocks.addPasskey.mockResolvedValue({
      data: { id: 'pk-row-id' },
      webauthn: {
        response: { id: 'pk-registered-id' },
        clientExtensionResults: { prf: { enabled: true } },
      },
    });
    mockPrfAssertion('pk-registered-id', new Uint8Array(32).fill(99));
    const enrolled = await createPasskeyVault({ account: ALICE, api, idbFactory });

    // The same credential on a second device: the server accepts it, the PRF output differs.
    mocks.signInPasskey.mockResolvedValue({
      data: { session: {}, user: userOf(ALICE) },
      webauthn: {
        response: { id: 'pk-registered-id' },
        clientExtensionResults: { prf: { results: { first: new Uint8Array(32).fill(7).buffer } } },
      },
    });
    await expect(loginWithPasskey({ api, idbFactory })).rejects.toThrow(
      PASSKEY_DERIVES_ANOTHER_KEY,
    );

    enrolled.store.close();
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

    await expect(createPasskeyVault({ account: ALICE, api, idbFactory })).rejects.toThrow(
      /could not be removed/,
    );
    // The row id: `/passkey/delete-passkey` resolves `where: [{ field: 'id' }]`.
    expect(mocks.deletePasskey).toHaveBeenCalledWith({ userId: 'user-123', passkeyId: 'pk-row' });
  });

  it('refuses to create a second vault over an enrolled account, which would strand every record', async () => {
    // `createVault()` mints a fresh DEK, and the server cannot tell a new DEK from a rewrap.
    const pw = await createPasswordVault({
      account: ALICE,
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

    await expect(createPasskeyVault({ account: ALICE, api, idbFactory })).rejects.toThrow(
      /already has a password vault/,
    );
    // Before registering anything.
    expect(mocks.addPasskey).not.toHaveBeenCalled();
  });

  it('refuses addPasskeyToSession from a password session — that is a mode switch', async () => {
    // The finalisation nulls the password wrap; from a password session the next reload could not unlock.
    const pw = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });

    await expect(
      addPasskeyToSession({ currentSession: pw, isCurrent: () => true, api }),
    ).rejects.toThrow(/use switchModeToPasskey/);
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
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });

    await pwSession.store.put({
      type: 'account',
      naturalKey: 'bank-acc',
      plaintext: 'Bank Details',
    });

    const toPasskey = await switchModeToPasskey({
      currentSession: pwSession,
      isCurrent: () => true,
      api,
    });
    if (toPasskey.outcome !== 'switched') throw new Error('the switch to a passkey ended');

    expect(toPasskey.session.mode).toBe('passkey');
    expect(alice.finalizePasskeyUnlock).toHaveBeenCalled();

    const toPassword = await switchModeToPassword({
      currentSession: toPasskey.session,
      isCurrent: () => true,
      password: 'newpassword456789',
      api,
    });
    if (toPassword.outcome !== 'switched') throw new Error('the switch to a password ended');

    expect(toPassword.session.mode).toBe('password');
    expect(alice.finalizePasswordUnlock).toHaveBeenCalled();

    pwSession.store.close();
  });

  it('reports a refused passkey registration from an old session as the one that needs confirming', async () => {
    const pw = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });
    mocks.addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh', status: 403 },
    });

    const refused = await switchModeToPasskey({ currentSession: pw, isCurrent: () => true }).catch(
      (error: unknown) => error,
    );
    expect(needsFreshSession(refused)).toBe(true);
    // Refused before any authenticator prompt, so nothing provisional was created to clean up.
    expect(mocks.deletePasskey).not.toHaveBeenCalled();
    pw.store.close();
  });

  it('confirms identity by the vault’s own method, and only as the same account', async () => {
    const pw = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });
    mocks.signInEmail.mockClear();

    await confirmIdentity({ currentSession: pw, password: 'password123456' });
    expect(mocks.signInEmail).toHaveBeenCalledTimes(1);
    expect(mocks.signInEmail.mock.calls[0]?.[0]).toBe('alice@example.com');
    // The auth value, never the password itself, leaves the tab.
    expect(mocks.signInEmail.mock.calls[0]?.[1]).not.toBe('password123456');

    mocks.signInEmail.mockResolvedValueOnce({ error: { message: 'Invalid password' } });
    await expect(
      confirmIdentity({ currentSession: pw, password: 'wrong-password-1' }),
    ).rejects.toThrow(/not the password this vault opens with/);

    const asPasskey = { ...pw, mode: 'passkey' as const };
    mocks.signInPasskey.mockResolvedValue({ data: { session: {}, user: userOf(ALICE) } });
    await confirmIdentity({ currentSession: asPasskey });
    expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);

    // The chooser offered a passkey of Bob's.
    mocks.signInPasskey.mockResolvedValueOnce({ data: { session: {}, user: userOf(BOB) } });
    await expect(confirmIdentity({ currentSession: asPasskey })).rejects.toThrow(
      /different account/,
    );
    pw.store.close();
  });

  describe('a change to an open session', () => {
    const passwordSession = async () => {
      const session = await createPasswordVault({
        account: ALICE,
        password: 'password123456',
        api,
        idbFactory,
      });
      vi.mocked(alice.finalizePasswordUnlock).mockClear();
      return session;
    };

    const registersPasskey = () => ({
      data: { id: 'pk-row' },
      webauthn: {
        response: { id: 'pk-added-key' },
        clientExtensionResults: { prf: { enabled: true } },
      },
    });

    it('names the session’s account on every write it makes', async () => {
      const pw = await passwordSession();
      mocks.addPasskey.mockResolvedValueOnce(registersPasskey());
      mockPrfAssertion('pk-added-key', new Uint8Array(32).fill(5));

      await switchModeToPasskey({ currentSession: pw, isCurrent: () => true, api });

      expect(mocks.addPasskey).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123' }),
      );
      expect(new Set(vi.mocked(api.forAccount).mock.calls.flat())).toEqual(new Set(['user-123']));
      expect(alice.finalizePasskeyUnlock).toHaveBeenCalledTimes(1);
      pw.store.close();
    });

    it('reports a registration refused for another account’s session, and writes nothing', async () => {
      const pw = await passwordSession();
      mocks.addPasskey.mockResolvedValueOnce({
        data: null,
        error: { code: 'ACCOUNT_MISMATCH', message: 'Signed in to another account', status: 403 },
      });

      const refused = await switchModeToPasskey({
        currentSession: pw,
        isCurrent: () => true,
        api,
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(VaultApiError);
      expect(refused).toMatchObject({ code: 'ACCOUNT_MISMATCH' });
      expect(alice.finalizePasskeyUnlock).not.toHaveBeenCalled();
      pw.store.close();
    });

    it('writes nothing once the session ended under the key derivation', async () => {
      const pw = await passwordSession();
      let isOpen = true;

      const switching = switchModeToPassword({
        currentSession: pw,
        isCurrent: () => isOpen,
        password: 'newpassword456789',
        api,
      });
      // PBKDF2's 650,000 rounds are still running.
      isOpen = false;

      expect(await switching).toEqual({ outcome: 'ended' });
      expect(alice.finalizePasswordUnlock).not.toHaveBeenCalled();
      pw.store.close();
    });

    it('asks for no second passkey gesture once the session ended under the first', async () => {
      const pw = await passwordSession();
      let isOpen = true;
      mocks.addPasskey.mockImplementationOnce(async () => {
        isOpen = false;
        return registersPasskey();
      });
      const prfGet = mockPrfAssertion('pk-added-key', new Uint8Array(32).fill(5));

      expect(
        await switchModeToPasskey({ currentSession: pw, isCurrent: () => isOpen, api }),
      ).toEqual({ outcome: 'ended' });
      expect(prfGet).not.toHaveBeenCalled();
      expect(alice.finalizePasskeyUnlock).not.toHaveBeenCalled();
      pw.store.close();
    });

    it('hands back no session once its own ended under the finalisation', async () => {
      // Written for this account, which is right; the tab is showing the next session by now.
      const pw = await passwordSession();
      let isOpen = true;
      vi.mocked(alice.finalizePasswordUnlock).mockImplementationOnce(async () => {
        isOpen = false;
      });

      expect(
        await switchModeToPassword({
          currentSession: pw,
          isCurrent: () => isOpen,
          password: 'newpassword456789',
          api,
        }),
      ).toEqual({ outcome: 'ended' });
      pw.store.close();
    });
  });

  /** Alice's password vault, with the keys a reload resumes from saved on this device. */
  const savedPasswordVault = async () => {
    const created = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });
    await saveUnlockKeys(await unlockKeysOf(created, api), idbFactory);
    created.store.close();
    vi.mocked(api.forAccount).mockClear();
    vi.mocked(alice.getUnlockStatus).mockClear();
    return created;
  };

  it('resumes a reload, asking for the stamp of the account the session names', async () => {
    const created = await savedPasswordVault();

    const { promise: session, resolve } = Promise.withResolvers<unknown>();
    mocks.getSession.mockReturnValueOnce(session);
    const resuming = resumeSession({ api, idbFactory });
    // Until the session says whose it is, there is no account to ask for.
    expect(api.forAccount).not.toHaveBeenCalled();
    resolve(worker.session());

    const resumed = await resuming;
    expect(api.forAccount).toHaveBeenCalledWith('user-123');
    expect(alice.getUnlockStatus).toHaveBeenCalledTimes(1);
    expect(resumed?.userId).toBe('user-123');
    expect(resumed?.wrappedDek).toBe(created.wrappedDek);
    resumed?.store.close();
  });

  it('resumes nothing, and keeps the keys, when another tab signs in under the session read', async () => {
    await savedPasswordVault();
    mocks.getSession.mockImplementationOnce(async () => {
      const aliceSession = worker.session();
      worker.signInAs(BOB);
      return aliceSession;
    });

    expect(await resumeSession({ api, idbFactory })).toBeNull();
    expect(await loadUnlockKeys('user-123', idbFactory)).not.toBeNull();
  });

  it('keeps the keys when the stamp cannot be read, and forgets them once it has changed', async () => {
    const created = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });
    await saveUnlockKeys(await unlockKeysOf(created, api), idbFactory);
    created.store.close();

    vi.mocked(alice.getUnlockStatus).mockRejectedValueOnce(new Error('offline'));
    expect(await resumeSession({ api, idbFactory })).toBeNull();
    expect(await loadUnlockKeys('user-123', idbFactory)).not.toBeNull();

    await alice.resetVault();
    expect(await resumeSession({ api, idbFactory })).toBeNull();
    expect(await loadUnlockKeys('user-123', idbFactory)).toBeNull();
  });

  it('resumes nothing when signed out, and asks for no stamp', async () => {
    worker.signInAs(null);
    expect(await resumeSession({ api, idbFactory })).toBeNull();
    expect(api.forAccount).not.toHaveBeenCalled();
  });
});

describe('createPasswordVault with a short password', () => {
  it('refuses before touching the server or the key schedule', async () => {
    const { api, vaultOf } = createMockWorker();
    const alice = vaultOf(ALICE.userId);
    await expect(
      createPasswordVault({
        account: { userId: 'user-123', email: 'a@b.c' },
        password: 'short',
        api,
        idbFactory: new IDBFactory(),
      }),
    ).rejects.toThrow(/at least 12 characters/);
    expect(alice.getUnlockStatus).not.toHaveBeenCalled();
    expect(alice.finalizePasswordUnlock).not.toHaveBeenCalled();
  });
});

describe('createPasswordVault over an enrolled account', () => {
  it('refuses before deriving anything, for the same reason the passkey path does', async () => {
    const { api, vaultOf } = createMockWorker();
    const alice = vaultOf(ALICE.userId);
    const idbFactory = new IDBFactory();

    const first = await createPasswordVault({
      account: ALICE,
      password: 'password123456',
      api,
      idbFactory,
    });
    first.store.close();

    await expect(
      createPasswordVault({
        account: ALICE,
        password: 'another-password',
        api,
        idbFactory,
      }),
    ).rejects.toThrow(/already has a password vault/);
    expect(alice.finalizePasswordUnlock).toHaveBeenCalledTimes(1);
  });
});
