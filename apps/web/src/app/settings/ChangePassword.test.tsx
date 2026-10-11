// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changePasswordOfSession } from '../../vault/unlock';
import { ChangePassword } from './ChangePassword';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessionOf = (mode: 'password' | 'passkey' = 'password') => ({
  userId: 'user-alice',
  email: 'alice@example.com',
  mode,
  store: { owner: 'user-alice' },
});

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  setSession: vi.fn(),
  navigate: vi.fn(async (_options: unknown) => {}),
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
  useVault: () => ({ session: mocks.session, setSession: mocks.setSession, lock: async () => {} }),
}));
vi.mock('../../store/MailProvider', () => ({
  useMail: () => ({ watchSession: () => () => true }),
}));
vi.mock('../../vault/unlock', () => ({
  MIN_PASSWORD_LENGTH: 12,
  UnlockError: class UnlockError extends Error {},
  WrongPasswordError: class WrongPasswordError extends Error {
    constructor() {
      super('That is not your current password.');
    }
  },
  needsFreshSession: () => false,
  changePasswordOfSession: vi.fn(),
  confirmIdentity: vi.fn(async () => {}),
}));
vi.mock('../../vault/passkey-prf', () => ({
  PasskeyPrfError: class PasskeyPrfError extends Error {},
}));
vi.mock('../../ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ChangePassword />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const type = async (id: string, value: string) => {
  const input = document.getElementById(id);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!(input instanceof HTMLInputElement) || setValue === undefined) {
    throw new Error(`no input #${id}`);
  }
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** The message under a field, which is its next sibling. */
const under = (id: string) => document.getElementById(id)?.nextElementSibling?.textContent;

/** Enter in a field submits the form around it. */
const submit = async () => {
  const form = document.getElementById('change-current')?.closest('form');
  if (form === null || form === undefined) throw new Error('no form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const fill = async (fields: { current?: string; password?: string; confirm?: string }) => {
  await type('change-current', fields.current ?? 'the current password');
  await type('change-password', fields.password ?? 'a brand new password');
  await type('change-confirm', fields.confirm ?? fields.password ?? 'a brand new password');
};

beforeEach(() => {
  mocks.session = sessionOf();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.resetAllMocks();
});

describe('ChangePassword', () => {
  it('is titled for what it does and goes back to Sign-in at every width', async () => {
    await mount();
    expect(document.querySelector('h2')?.textContent).toBe('Change password');
    const back = document.querySelector('a[href="/settings/account"]');
    expect(back?.textContent).toContain('Sign-in');
    // A sub-page is one level below the list beside it, so its way back shows on a desktop too.
    expect(back?.className).not.toContain('lg:hidden');
    expect(document.body.textContent).toContain('nobody can recover your saved addresses');
  });

  it('checks each field under it, and asks the vault for nothing until all three pass', async () => {
    await mount();

    await fill({ current: '' });
    await submit();
    expect(under('change-current')).toBe('Enter your current password.');

    await fill({ password: 'short', confirm: 'short' });
    await submit();
    expect(under('change-password')).toBe('Use at least 12 characters.');

    await fill({ password: 'a brand new password', confirm: 'a different password' });
    await submit();
    expect(under('change-confirm')).toBe('The two passwords do not match.');
    expect(changePasswordOfSession).not.toHaveBeenCalled();
  });

  it('says a wrong current password under that field, and keeps what was typed', async () => {
    const { WrongPasswordError } = await import('../../vault/unlock');
    vi.mocked(changePasswordOfSession).mockRejectedValueOnce(new WrongPasswordError());
    await mount();
    await fill({});

    await submit();

    expect(under('change-current')).toBe('That is not your current password.');
    expect((document.getElementById('change-password') as HTMLInputElement).value).toBe(
      'a brand new password',
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('hands over both passwords, then goes back to Sign-in saying so', async () => {
    vi.mocked(changePasswordOfSession).mockResolvedValueOnce({
      outcome: 'changed',
      session: sessionOf(),
    } as never);
    await mount();
    await fill({ current: 'the current password', password: 'a brand new password' });

    await submit();

    expect(changePasswordOfSession).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPassword: 'the current password',
        newPassword: 'a brand new password',
      }),
    );
    expect(mocks.setSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'password' }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/settings/account',
      search: { notice: 'changed' },
    });
  });

  it('says any other failure in the pane, not under a field', async () => {
    vi.mocked(changePasswordOfSession).mockRejectedValueOnce(new Error('The server failed.'));
    await mount();
    await fill({});

    await submit();

    expect(document.body.textContent).toContain('The server failed.');
    expect(under('change-current')).toBeUndefined();
  });

  it('says only that saving takes a moment, with no word of keys or rounds', async () => {
    const held = Promise.withResolvers<never>();
    vi.mocked(changePasswordOfSession).mockReturnValueOnce(held.promise);
    await mount();
    await fill({});

    await submit();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Saving…');
    expect(text).toContain('This takes a few seconds.');
    expect(text).not.toMatch(/keys|PBKDF2|rounds|derive/i);
  });
});
