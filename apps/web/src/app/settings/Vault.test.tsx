// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPasskeyToSession,
  confirmIdentity,
  resetVaultAccount,
  switchModeToPasskey,
} from '../../vault/unlock';
import { Vault } from './Vault';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessionOf = (userId: string, email: string) => ({
  userId,
  email,
  mode: 'password',
  store: { owner: userId },
});

/** A password vault whose session a test can end or replace; each held step is resolved by hand. */
const mocks = vi.hoisted(() => ({
  generation: 0,
  session: null as unknown,
  setSession: vi.fn(),
  lock: vi.fn(async () => {}),
  navigate: vi.fn(async (_options: unknown) => {}),
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
  needsFreshSession: (error: unknown) => error === 'not fresh',
  switchModeToPasskey: vi.fn(),
  switchModeToPassword: vi.fn(),
  addPasskeyToSession: vi.fn(),
  confirmIdentity: vi.fn(async () => {}),
  resetVaultAccount: vi.fn(async () => {}),
}));
vi.mock('../../vault/auth-client', () => ({ signOut: () => mocks.signingOut.promise }));
vi.mock('../../vault/passkey-prf', () => ({ checkPasskeyPrfCapability: async () => 'supported' }));
vi.mock('../../vault/api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://api.test',
}));
// Device-wide pins in IndexedDB; nothing here is about them.
vi.mock('../../relay/ServerKeysSection', () => ({ ServerKeysSection: () => null }));
// The real one is a Base UI portal; what is under test is what its confirmation runs.
vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ title, onConfirm }: { title: string; onConfirm: () => Promise<void> }) => (
    <button type="button" onClick={() => void onConfirm()}>
      {title}
    </button>
  ),
}));

const unmounts: (() => Promise<void>)[] = [];
let rerender = async () => {};

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  rerender = () => act(async () => root.render(<Vault />));
  await rerender();
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find(candidate => candidate.textContent === label);

const click = async (label: string) => {
  const found = button(label);
  if (found === undefined) throw new Error(`no "${label}" button`);
  await act(async () => found.click());
};

/** A sign-in as someone else over this session, in this tab: the page stays mounted. */
const replaceSession = async () => {
  mocks.generation += 1;
  mocks.session = sessionOf('user-bob', 'bob@example.com');
  await rerender();
};

beforeEach(() => {
  mocks.session = sessionOf('user-alice', 'alice@example.com');
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  // Reset, not cleared: a test whose held retry never ran must not hand it to the next.
  vi.resetAllMocks();
});

describe('Vault', () => {
  it('hands a mode switch the guard of the session it started in, and opens nothing once it ended', async () => {
    const switching = Promise.withResolvers<{ outcome: 'ended' }>();
    vi.mocked(switchModeToPasskey).mockReturnValueOnce(switching.promise);
    await mount();
    await click('Switch to a passkey');

    const [{ isCurrent }] = vi.mocked(switchModeToPasskey).mock.calls[0]!;
    mocks.generation += 1;
    expect(isCurrent()).toBe(false);
    await act(async () => switching.resolve({ outcome: 'ended' }));
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

  describe('a change that needs a fresh sign-in', () => {
    const refuseThenSwitch = () => {
      vi.mocked(switchModeToPasskey)
        .mockRejectedValueOnce('not fresh')
        .mockResolvedValueOnce({
          outcome: 'switched',
          session: { ...sessionOf('user-alice', 'alice@example.com'), mode: 'passkey' },
        } as never);
    };

    it('confirms and runs again in the session it was refused in', async () => {
      refuseThenSwitch();
      await mount();
      await click('Switch to a passkey');

      await click('Confirm');
      expect(confirmIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ currentSession: mocks.session }),
      );
      expect(switchModeToPasskey).toHaveBeenCalledTimes(2);
      expect(mocks.setSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'passkey' }));
      expect(button('Confirm')).toBeUndefined();
    });

    it('is not offered to the account that signed in over the session it was refused in', async () => {
      refuseThenSwitch();
      await mount();
      await click('Switch to a passkey');
      expect(button('Confirm')).toBeDefined();

      await replaceSession();
      expect(button('Confirm')).toBeUndefined();
      expect(confirmIdentity).not.toHaveBeenCalled();
      expect(switchModeToPasskey).toHaveBeenCalledTimes(1);
    });

    it('confirms nothing and runs nothing once that session ended, even before the screen knows', async () => {
      refuseThenSwitch();
      await mount();
      await click('Switch to a passkey');

      // A lock or a sign-in has landed and this screen has not rendered since.
      mocks.generation += 1;
      await click('Confirm');
      expect(confirmIdentity).not.toHaveBeenCalled();
      expect(switchModeToPasskey).toHaveBeenCalledTimes(1);
      expect(button('Confirm')).toBeUndefined();
    });

    it('adds the passkey once confirmed, under the guard it was refused with', async () => {
      mocks.session = { ...sessionOf('user-alice', 'alice@example.com'), mode: 'passkey' };
      vi.mocked(addPasskeyToSession)
        .mockRejectedValueOnce('not fresh')
        .mockResolvedValueOnce({ outcome: 'added' });
      await mount();
      await click('Add passkey');

      await click('Confirm with your passkey');
      const [, retried] = vi.mocked(addPasskeyToSession).mock.calls;
      expect(retried?.[0].isCurrent()).toBe(true);
      expect(document.body.textContent).toContain('Added. That authenticator can now open');
    });
  });

  describe('reset', () => {
    it('names the session’s account, then goes to enrolment and locks', async () => {
      await mount();
      await click('Reset this vault?');

      expect(resetVaultAccount).toHaveBeenCalledWith('user-alice');
      expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/enrol' }));
      expect(mocks.lock).toHaveBeenCalledTimes(1);
    });

    it('sends nobody to enrolment who opened a session while its keys were being forgotten', async () => {
      const forgetting = Promise.withResolvers<void>();
      mocks.lock.mockReturnValueOnce(forgetting.promise);
      await mount();
      await click('Reset this vault?');

      const navigatedBeforeTheNextSession = mocks.navigate.mock.calls.length;
      await replaceSession();
      await act(async () => forgetting.resolve());
      expect(navigatedBeforeTheNextSession).toBe(1);
      expect(mocks.navigate).toHaveBeenCalledTimes(1);
    });
  });
});
