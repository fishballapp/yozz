// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { switchModeToPassword } from '../../vault/unlock';
import { SwitchToPassword } from './SwitchToPassword';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sessionOf = (mode: 'password' | 'passkey') => ({
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
  needsFreshSession: () => false,
  switchModeToPassword: vi.fn(),
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
  await act(async () => root.render(<SwitchToPassword />));
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

/** Enter in a field submits the form around it. */
const submitFormAround = async (id: string) => {
  const form = document.getElementById(id)?.closest('form');
  if (form === null || form === undefined) throw new Error(`no form around #${id}`);
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  mocks.session = sessionOf('passkey');
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.resetAllMocks();
});

describe('SwitchToPassword', () => {
  it('checks its fields under them and says what a forgotten password costs, before it saves', async () => {
    await mount();
    expect(document.body.textContent).toContain('nobody can recover your saved addresses');
    // Phone back link: to Sign-in, not the list.
    expect(document.querySelector('a[href="/settings/account"]')?.textContent).toContain('Sign-in');

    await type('switch-password', 'short');
    await type('switch-confirm', 'short');
    await submitFormAround('switch-password');
    expect(document.body.textContent).toContain('Use at least 12 characters.');

    await type('switch-password', 'long enough password');
    await type('switch-confirm', 'a different password');
    await submitFormAround('switch-confirm');
    expect(document.getElementById('switch-confirm')?.nextElementSibling?.textContent).toBe(
      'The two passwords do not match.',
    );
    expect(switchModeToPassword).not.toHaveBeenCalled();
  });

  it('goes back to Account with the notice once it is switched', async () => {
    vi.mocked(switchModeToPassword).mockResolvedValueOnce({
      outcome: 'switched',
      session: sessionOf('password'),
    } as never);
    await mount();
    await type('switch-password', 'long enough password');
    await type('switch-confirm', 'long enough password');
    await submitFormAround('switch-password');

    expect(mocks.setSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'password' }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/settings/account',
      search: { notice: 'switched' },
    });
  });
});
