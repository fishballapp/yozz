import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Answers each Better Auth path, recording the account each request named. */
const stubWorker = (answers: Record<string, unknown>) => {
  const named = new Map<string, string | null>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      named.set(path, request.headers.get(ACCOUNT_HEADER));
      return Response.json(answers[path] ?? {});
    }),
  );
  return named;
};

/** Just enough of an authenticator for SimpleWebAuthn to build its registration response. */
const stubAuthenticator = () => {
  vi.stubGlobal('PublicKeyCredential', () => {});
  vi.stubGlobal('navigator', {
    credentials: {
      create: async () => ({
        id: 'cred',
        rawId: new ArrayBuffer(4),
        type: 'public-key',
        response: { attestationObject: new ArrayBuffer(4), clientDataJSON: new ArrayBuffer(4) },
        getClientExtensionResults: () => ({}),
      }),
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('auth client', () => {
  it('names the account on every account-scoped request', async () => {
    const named = stubWorker({
      '/api/auth/passkey/generate-register-options': {
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'localhost', name: 'YOZZ' },
        user: { id: 'dXNlcg', name: 'alice@example.com', displayName: 'alice@example.com' },
        pubKeyCredParams: [],
      },
      '/api/auth/passkey/verify-registration': { id: 'pk-row' },
    });
    stubAuthenticator();
    // Imported after the stub: Better Auth's client keeps the `fetch` it was created with.
    const { addPasskeyAuthenticator, deletePasskeyAuthenticator, signOut } = await import(
      './auth-client'
    );

    await addPasskeyAuthenticator({ userId: 'user-123' });
    await deletePasskeyAuthenticator({ userId: 'user-123', passkeyId: 'pk-row' });
    await signOut('user-123');

    expect(Object.fromEntries(named)).toEqual({
      '/api/auth/passkey/generate-register-options': 'user-123',
      '/api/auth/passkey/verify-registration': 'user-123',
      '/api/auth/passkey/delete-passkey': 'user-123',
      '/api/auth/sign-out': 'user-123',
    });
  });
});
