// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './Vault';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A password vault whose mode switch and sign-out are held, with a session a test can end. */
const mocks = vi.hoisted(() => ({
  generation: 0,
  session: { mode: 'password', email: 'alice@example.com' },
  setSession: vi.fn(),
  lock: vi.fn(async () => {}),
  navigate: vi.fn(async (_options: unknown) => {}),
  switching: Promise.withResolvers<unknown>(),
  signingOut: Promise.withResolvers<{ error: null }>(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('../../vault/session', () => ({
  useVault: () => ({ session: mocks.session, setSession: mocks.setSession, lock: mocks.lock }),
}));
vi.mock('../../store/MailProvider', () => ({
  useMail: () => ({
    watchSession: () => {
      const taken = mocks.generation;
      return () => mocks.generation === taken;
    },
  }),
}));
vi.mock('../../vault/unlock', () => ({
  MIN_PASSWORD_LENGTH: 12,
  needsFreshSession: () => false,
  switchModeToPasskey: () => mocks.switching.promise,
  switchModeToPassword: vi.fn(),
  addPasskeyToSession: vi.fn(),
  confirmIdentity: vi.fn(),
  resetVaultAccount: vi.fn(),
}));
vi.mock('../../vault/auth-client', () => ({ signOut: () => mocks.signingOut.promise }));
vi.mock('../../vault/passkey-prf', () => ({ checkPasskeyPrfCapability: async () => 'supported' }));
vi.mock('../../vault/api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://api.test',
}));
// Device-wide pins in IndexedDB; nothing here is about them.
vi.mock('../../relay/ServerKeysSection', () => ({ ServerKeysSection: () => null }));

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Vault />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const click = async (label: string) => {
  const found = [...document.body.querySelectorAll('button')].find(
    candidate => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  await act(async () => found.click());
};

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.clearAllMocks();
});

describe('Vault', () => {
  it('reopens nothing once the session ended under a mode switch', async () => {
    await mount();
    await click('Switch to a passkey');

    mocks.generation += 1;
    await act(async () => mocks.switching.resolve({ mode: 'passkey' }));
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it('locks nothing and goes nowhere once the session ended under the sign-out', async () => {
    await mount();
    await click('Sign out');

    mocks.generation += 1;
    await act(async () => mocks.signingOut.resolve({ error: null }));
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
