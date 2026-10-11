// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPasskeyToSession, confirmIdentity, deleteAccount } from '../../vault/unlock';
import { Account } from './Account';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessionOf = (userId: string, email: string, mode: 'password' | 'passkey' = 'password') => ({
  userId,
  email,
  mode,
  store: { owner: userId },
});

/** A session a test can end or replace; each held step is resolved by hand. */
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
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
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
  UnlockError: class UnlockError extends Error {},
  needsFreshSession: (error: unknown) => error === 'not fresh',
  switchModeToPasskey: vi.fn(),
  switchModeToPassword: vi.fn(),
  addPasskeyToSession: vi.fn(),
  confirmIdentity: vi.fn(async () => {}),
  deleteAccount: vi.fn(async () => {}),
}));
vi.mock('../../vault/auth-client', () => ({ signOut: () => mocks.signingOut.promise }));
vi.mock('../../vault/passkey-prf', () => ({
  checkPasskeyPrfCapability: async () => 'supported',
  PasskeyPrfError: class PasskeyPrfError extends Error {},
}));
vi.mock('../../vault/api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://api.test',
}));
// The real one is a Base UI portal; modelled as its two shapes: a trigger, or a controlled question.
vi.mock('../../ui/ConfirmDialog', async () => {
  const { useState } = await import('react');
  return {
    ConfirmDialog: ({
      title,
      description,
      children,
      confirmLabel,
      triggerLabel,
      trigger,
      open,
      onOpenChange,
      isConfirmEnabled = true,
      onConfirm,
    }: {
      title: string;
      description: string;
      children?: React.ReactNode;
      confirmLabel: string;
      triggerLabel?: string;
      trigger?: unknown;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      isConfirmEnabled?: boolean;
      onConfirm: () => Promise<void>;
    }) => {
      const [openHere, setOpenHere] = useState(false);
      const isOpen = open ?? openHere;
      const setOpen = (next: boolean) => {
        setOpenHere(next);
        onOpenChange?.(next);
      };
      return (
        <>
          {trigger !== undefined && (
            <button type="button" onClick={() => setOpen(true)}>
              {triggerLabel}
            </button>
          )}
          {isOpen && (
            <div role="alertdialog">
              <h2>{title}</h2>
              <p>{description}</p>
              {children}
              <button
                type="button"
                disabled={!isConfirmEnabled}
                onClick={() =>
                  void onConfirm().then(
                    () => setOpen(false),
                    () => {},
                  )
                }
              >
                {confirmLabel}
              </button>
            </div>
          )}
        </>
      );
    },
  };
});

const unmounts: (() => Promise<void>)[] = [];

let rerender = async () => {};

const mount = async (notice?: 'switched' | 'changed') => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  rerender = () => act(async () => root.render(<Account notice={notice} />));
  await rerender();
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

/** The last match: a dialog's own button comes after the trigger that opened it. */
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].findLast(
    candidate => candidate.textContent === label,
  );

/** One tick inside the act scope, so a rejected check and the render it sets off land before reads. */
const click = async (label: string) => {
  const found = button(label);
  if (found === undefined) throw new Error(`no "${label}" button`);
  await act(async () => {
    found.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const linkTo = (label: string) =>
  [...document.body.querySelectorAll('a')].find(candidate => candidate.textContent === label);

/** Types into the delete question's field. */
const typeConfirmation = async (value: string) => {
  const input = document.getElementById('delete-account-confirm');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!(input instanceof HTMLInputElement) || setValue === undefined) {
    throw new Error('no confirmation field');
  }
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

describe('Account', () => {
  it('says how you sign in, and links to the one change that is on offer', async () => {
    await mount();
    expect(document.body.textContent).toContain('You sign in with a password.');
    expect(linkTo('Change password')?.getAttribute('href')).toBe('/settings/account/password');
    expect(linkTo('Switch to a passkey')?.getAttribute('href')).toBe('/settings/account/passkey');
    expect(linkTo('Switch to a password')).toBeUndefined();

    mocks.session = sessionOf('user-alice', 'alice@example.com', 'passkey');
    await mount();
    expect(linkTo('Switch to a password')?.getAttribute('href')).toBe('/settings/account/password');
  });

  it('says in a word what the change that brought it here did, politely', async () => {
    await mount('switched');
    const notice = document.querySelector('[role="status"]');
    expect(notice?.textContent).toBe('Switched.');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
    // Said once: the sentence above it already says how you sign in now.
    expect(document.body.textContent).not.toContain('You now sign in with');

    await mount('changed');
    expect(document.body.textContent).toContain('Password changed.');
  });

  it('is titled by what it holds, and has no reset', async () => {
    await mount();
    expect(document.querySelector('h2')?.textContent).toBe('Sign-in');
    // A top-level pane goes back to the list.
    const back = document.querySelector('a[href="/settings"]');
    expect(back?.textContent).toContain('Settings');
    expect(back?.className).toContain('lg:hidden');
    expect(button('Reset')).toBeUndefined();
    expect(document.body.textContent).not.toContain('new key');
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
    beforeEach(() => {
      mocks.session = sessionOf('user-alice', 'alice@example.com', 'passkey');
    });

    it('asks Confirm it’s you in place, then adds the passkey under the guard it was refused with', async () => {
      vi.mocked(addPasskeyToSession)
        .mockRejectedValueOnce('not fresh')
        .mockResolvedValueOnce({ outcome: 'added' });
      await mount();
      await click('Add passkey');
      expect(document.body.textContent).toContain('Confirm it’s you');

      await click('Confirm with your passkey');
      const [, retried] = vi.mocked(addPasskeyToSession).mock.calls;
      expect(retried?.[0].isCurrent()).toBe(true);
      expect(document.body.textContent).toContain('Added. That passkey can now sign you in.');
    });

    it('keeps the question open with the reason when the current password is wrong', async () => {
      mocks.session = sessionOf('user-alice', 'alice@example.com');
      vi.mocked(deleteAccount).mockRejectedValueOnce('not fresh');
      vi.mocked(confirmIdentity).mockRejectedValueOnce(new Error('That password is wrong.'));
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');

      await click('Confirm');
      expect(document.body.textContent).toContain('That password is wrong.');
      expect(button('Confirm')).toBeDefined();
    });

    it('is not offered to the account that signed in over the session it was refused in', async () => {
      vi.mocked(addPasskeyToSession).mockRejectedValueOnce('not fresh');
      await mount();
      await click('Add passkey');
      expect(document.body.textContent).toContain('Confirm it’s you');

      await replaceSession();
      expect(document.body.textContent).not.toContain('Confirm it’s you');
      expect(confirmIdentity).not.toHaveBeenCalled();
    });
  });

  describe('delete account', () => {
    it('says what goes and what stays out of reach, before it asks anything', async () => {
      await mount();
      const text = document.body.textContent ?? '';
      expect(text).toContain('your saved addresses and their passwords, your drafts');
      expect(text).toContain(
        'Sent copies and draft copies YOZZ put in your mailboxes, stays there',
      );
      expect(button('Reset')).toBeUndefined();
    });

    it('says it cannot be undone and keeps Delete account off until DELETE is typed', async () => {
      await mount();
      await click('Delete account');
      expect(document.body.textContent).toContain('This cannot be undone.');
      expect(document.body.textContent).toContain('alice@example.com');
      expect(button('Delete account')?.disabled).toBe(true);

      await typeConfirmation('delete');
      expect(button('Delete account')?.disabled).toBe(true);
      await typeConfirmation('DELETE');
      expect(button('Delete account')?.disabled).toBe(false);
      expect(deleteAccount).not.toHaveBeenCalled();
    });

    it('deletes, then locks and lands on the signed-out screen saying so', async () => {
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');

      expect(deleteAccount).toHaveBeenCalledWith('user-alice');
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/login', search: { deleted: true } });
      expect(mocks.lock).toHaveBeenCalledTimes(1);
    });

    it('keeps the question open with the reason when the server refuses, and locks nothing', async () => {
      vi.mocked(deleteAccount).mockRejectedValueOnce(new Error('The server failed on that.'));
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');

      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        'The server failed on that.',
      );
      expect(mocks.lock).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it('asks Confirm it’s you for a session older than a day, then deletes under it', async () => {
      vi.mocked(deleteAccount).mockRejectedValueOnce('not fresh').mockResolvedValueOnce();
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');
      expect(document.body.textContent).toContain('Confirm it’s you');
      expect(mocks.lock).not.toHaveBeenCalled();

      await click('Confirm');
      expect(deleteAccount).toHaveBeenCalledTimes(2);
      expect(mocks.lock).toHaveBeenCalledTimes(1);
    });

    it('is closed and empty for the account that signed in over the pane, who is never deleted by it', async () => {
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      expect(button('Delete account')?.disabled).toBe(false);

      await replaceSession();
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();

      await click('Delete account');
      expect(document.body.textContent).toContain('bob@example.com');
      expect(button('Delete account')?.disabled).toBe(true);
      expect(deleteAccount).not.toHaveBeenCalled();
    });

    it('lands on the signed-out screen only once this device has forgotten its keys', async () => {
      const forgetting = Promise.withResolvers<void>();
      mocks.lock.mockReturnValueOnce(forgetting.promise);
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');
      expect(mocks.navigate).not.toHaveBeenCalled();

      await act(async () => forgetting.resolve());
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/login', search: { deleted: true } });
    });
  });
});
