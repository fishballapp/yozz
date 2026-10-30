// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCliKeys, revokeCliKey } from '../../vault/cli-keys';
import {
  type AccountPasskey,
  addPasskeyToSession,
  confirmIdentity,
  deleteAccount,
  listPasskeys,
  removePasskey,
  renamePasskey,
} from '../../vault/unlock';
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
  listPasskeys: vi.fn(async () => []),
  removePasskey: vi.fn(async () => {}),
  renamePasskey: vi.fn(async () => {}),
}));
vi.mock('../../vault/cli-keys', () => ({
  listCliKeys: vi.fn(async () => []),
  revokeCliKey: vi.fn(async () => {}),
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
      cancelLabel = 'Cancel',
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
      cancelLabel?: string;
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
              <button type="button" onClick={() => setOpen(false)}>
                {cancelLabel}
              </button>
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
        .mockResolvedValueOnce({ outcome: 'added', passkeyId: 'pk-new', name: 'Chrome on Mac' });
      await mount();
      await click('Add passkey');
      expect(document.body.textContent).toContain('Confirm it’s you');

      await click('Confirm with your passkey');
      const [, retried] = vi.mocked(addPasskeyToSession).mock.calls;
      expect(retried?.[0].isCurrent()).toBe(true);
      expect(document.body.textContent).toContain('Added. That passkey can now sign you in.');
    });

    it('says the change is to how you sign in when a sign-in change asked', async () => {
      vi.mocked(addPasskeyToSession).mockRejectedValueOnce('not fresh');
      await mount();
      await click('Add passkey');
      expect(document.body.textContent).toContain('Changing how you sign in needs a fresh sign-in');
    });

    it('says the change is revoking a CLI key when Revoke asked, then revokes under it', async () => {
      vi.mocked(listCliKeys).mockResolvedValue([
        {
          keyId: '0f8fad5b-d9cb-469f-a165-70867728950e',
          name: 'jasons-mbp',
          publicKey: 'unused',
          pairingCode: 'K7Q2-M9XD',
          createdAt: 0,
          lastUsedAt: null,
        },
      ]);
      vi.mocked(revokeCliKey).mockRejectedValueOnce('not fresh').mockResolvedValueOnce();
      await mount();
      await click('Revoke');
      await click('Revoke key');
      expect(document.body.textContent).toContain('Revoking a CLI key needs a fresh sign-in');
      expect(document.body.textContent).not.toContain('Changing how you sign in');

      await click('Confirm with your passkey');
      expect(revokeCliKey).toHaveBeenCalledTimes(2);
    });

    it('says the change is deleting the account when Delete account asked', async () => {
      vi.mocked(deleteAccount).mockRejectedValueOnce('not fresh');
      await mount();
      await click('Delete account');
      await typeConfirmation('DELETE');
      await click('Delete account');
      expect(document.body.textContent).toContain('Deleting your account needs a fresh sign-in');
      expect(document.body.textContent).not.toContain('Changing how you sign in');
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

  describe('passkeys', () => {
    const LAPTOP: AccountPasskey = {
      id: 'pk-laptop',
      credentialId: 'cred-laptop',
      name: 'MacBook',
      addedAt: Date.parse('2026-09-01T09:00:00.000Z'),
    };
    const PHONE: AccountPasskey = {
      id: 'pk-phone',
      credentialId: 'cred-phone',
      name: null,
      addedAt: Date.parse('2026-10-05T09:00:00.000Z'),
    };

    const ADDED = { outcome: 'added', passkeyId: 'pk-new', name: 'Chrome on Mac' } as const;

    beforeEach(() => {
      mocks.session = sessionOf('user-alice', 'alice@example.com', 'passkey');
      vi.mocked(listPasskeys).mockResolvedValue([LAPTOP, PHONE]);
    });

    /** The Remove button of one row, by the name its row is labelled with. */
    const removeButtonOf = (rowLabel: string) =>
      [...document.body.querySelectorAll('li')]
        .find(row => row.textContent?.includes(rowLabel))
        ?.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]');

    const clickRemoveOf = async (rowLabel: string) => {
      const found = removeButtonOf(rowLabel);
      if (found === null || found === undefined) throw new Error(`no Remove in "${rowLabel}"`);
      await act(async () => found.click());
    };

    it('lists each passkey by name, "Passkey" when it has none, and the day it was added', async () => {
      await mount();

      const rows = [...document.body.querySelectorAll('li')].map(row => row.textContent);
      expect(rows).toEqual([
        'MacBookAdded 1 Sept 2026RenameRemove',
        'PasskeyAdded 5 Oct 2026RenameRemove',
      ]);
      expect(listPasskeys).toHaveBeenCalledWith('user-alice');
    });

    it('offers no Remove for the only passkey, and says to add another first', async () => {
      vi.mocked(listPasskeys).mockResolvedValue([PHONE]);
      await mount();

      expect(document.body.querySelectorAll('li')).toHaveLength(1);
      expect(button('Remove')).toBeUndefined();
      expect(document.body.textContent).toContain(
        'This is your only passkey. Add another before you can remove it.',
      );
    });

    it('asks before removing, saying who can no longer sign in and who still can', async () => {
      await mount();
      await clickRemoveOf('MacBook');

      const dialog = document.querySelector('[role="alertdialog"]')?.textContent ?? '';
      expect(dialog).toContain('Remove this passkey?');
      expect(dialog).toContain('can no longer sign in to alice@example.com');
      expect(dialog).toContain('every other device is signed out. Your other passkeys still work.');
      expect(dialog).not.toMatch(/vault/i);
      expect(removePasskey).not.toHaveBeenCalled();
    });

    it('removes the one asked about, reloads the list and keeps this device signed in', async () => {
      await mount();
      vi.mocked(listPasskeys).mockResolvedValue([PHONE]);
      await clickRemoveOf('MacBook');
      await click('Remove passkey');

      expect(removePasskey).toHaveBeenCalledWith({
        userId: 'user-alice',
        credentialId: 'cred-laptop',
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.body.querySelectorAll('li')).toHaveLength(1);
      expect(mocks.setSession).toHaveBeenCalledTimes(1);
    });

    it('keeps the question open with the reason when the server refuses it', async () => {
      vi.mocked(removePasskey).mockRejectedValueOnce(new Error('This is the only passkey.'));
      await mount();
      await clickRemoveOf('MacBook');
      await click('Remove passkey');

      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain('This is the only passkey.');
      // Said once, in the dialog, and not again in the section behind it.
      expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(mocks.setSession).not.toHaveBeenCalled();
    });

    it('asks Confirm it’s you for a session older than a day, then removes under it', async () => {
      vi.mocked(removePasskey).mockRejectedValueOnce('not fresh').mockResolvedValueOnce();
      await mount();
      await clickRemoveOf('MacBook');
      await click('Remove passkey');
      expect(document.body.textContent).toContain('Confirm it’s you');

      await click('Confirm with your passkey');
      expect(removePasskey).toHaveBeenCalledTimes(2);
      expect(mocks.setSession).toHaveBeenCalledTimes(1);
    });

    /** Types into the naming dialog's field. */
    const typeName = async (value: string) => {
      const input = document.getElementById('passkey-name');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLInputElement) || setValue === undefined) {
        throw new Error('no name field');
      }
      await act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    const nameField = () => {
      const input = document.getElementById('passkey-name');
      if (!(input instanceof HTMLInputElement)) throw new Error('no name field');
      return input;
    };

    describe('naming the one just added', () => {
      beforeEach(() => {
        vi.mocked(addPasskeyToSession).mockResolvedValue(ADDED);
      });

      it('opens at once with the automatic name filled in and selected, so typing replaces it', async () => {
        await mount();
        await click('Add passkey');

        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
          'Name this passkey',
        );
        const input = nameField();
        expect(input.value).toBe('Chrome on Mac');
        expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Chrome on Mac'.length]);
        expect(button('Skip')).toBeDefined();
      });

      it('saves the typed name against the passkey that was added', async () => {
        await mount();
        await click('Add passkey');
        await typeName('  Work laptop ');
        await click('Save');

        expect(renamePasskey).toHaveBeenCalledWith({
          userId: 'user-alice',
          passkeyId: 'pk-new',
          name: 'Work laptop',
        });
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      });

      it('keeps the automatic name on Skip, and writes nothing more', async () => {
        await mount();
        await click('Add passkey');
        await click('Skip');

        expect(renamePasskey).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      });

      it('takes a blank name as the automatic one, and writes it', async () => {
        await mount();
        await click('Add passkey');
        await typeName('   ');
        await click('Save');

        expect(renamePasskey).toHaveBeenCalledWith({
          userId: 'user-alice',
          passkeyId: 'pk-new',
          name: 'Chrome on Mac',
        });
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      });

      // The automatic write may have failed unseen; Save is what makes sure the passkey has a name.
      it('writes the name it offered when Save is pressed without an edit', async () => {
        await mount();
        await click('Add passkey');
        await click('Save');

        expect(renamePasskey).toHaveBeenCalledTimes(1);
        expect(renamePasskey).toHaveBeenCalledWith({
          userId: 'user-alice',
          passkeyId: 'pk-new',
          name: 'Chrome on Mac',
        });
      });

      it('caps the field at the length the Worker accepts', async () => {
        await mount();
        await click('Add passkey');

        expect(nameField().maxLength).toBe(60);
      });

      it('keeps the question open with the reason when the name cannot be saved', async () => {
        vi.mocked(renamePasskey).mockRejectedValueOnce(new Error('That name could not be saved.'));
        await mount();
        await click('Add passkey');
        await typeName('Work laptop');
        await click('Save');

        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
          'That name could not be saved.',
        );
      });
    });

    describe('renaming one that is listed', () => {
      it('offers Rename on every row, the only passkey included', async () => {
        vi.mocked(listPasskeys).mockResolvedValue([PHONE]);
        await mount();

        expect(button('Rename')).toBeDefined();
        expect(button('Remove')).toBeUndefined();
      });

      it('opens with the name it has, and saves the new one against that passkey', async () => {
        await mount();
        await act(async () => {
          document
            .querySelector<HTMLButtonElement>('button[aria-label^="Rename MacBook"]')
            ?.click();
        });

        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
          'Rename passkey',
        );
        expect(button('Skip')).toBeUndefined();
        expect(nameField().value).toBe('MacBook');

        await typeName('Home desktop');
        await click('Save');
        expect(renamePasskey).toHaveBeenCalledWith({
          userId: 'user-alice',
          passkeyId: 'pk-laptop',
          name: 'Home desktop',
        });
        expect(listPasskeys).toHaveBeenCalledTimes(2);
      });

      it('starts empty for a passkey with no name, and will not save a blank one', async () => {
        await mount();
        await act(async () => {
          document
            .querySelector<HTMLButtonElement>('button[aria-label^="Rename Passkey"]')
            ?.click();
        });

        expect(nameField().value).toBe('');
        expect(button('Save')?.disabled).toBe(true);
        await typeName('Phone');
        expect(button('Save')?.disabled).toBe(false);
      });
    });

    it('lists again after a passkey is added', async () => {
      vi.mocked(addPasskeyToSession).mockResolvedValue(ADDED);
      await mount();
      vi.mocked(listPasskeys).mockResolvedValue([
        LAPTOP,
        PHONE,
        { ...PHONE, id: 'pk-new', credentialId: 'c3' },
      ]);
      await click('Add passkey');

      expect(document.body.querySelectorAll('li')).toHaveLength(3);
      expect(mocks.setSession).toHaveBeenCalledTimes(1);
    });

    it('shows the account that signed in over the pane none of the one before', async () => {
      await mount();
      const bobsList = Promise.withResolvers<readonly AccountPasskey[]>();
      vi.mocked(listPasskeys).mockReturnValueOnce(bobsList.promise);
      mocks.session = sessionOf('user-bob', 'bob@example.com', 'passkey');
      mocks.generation += 1;
      await rerender();

      expect(document.body.querySelectorAll('li')).toHaveLength(0);
      expect(listPasskeys).toHaveBeenLastCalledWith('user-bob');
      await act(async () => bobsList.resolve([PHONE]));
      expect(document.body.textContent).toContain('Passkey');
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
