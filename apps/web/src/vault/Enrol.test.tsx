// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Enrol } from './Enrol';
import type { PrfCapability } from './passkey-prf';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  prf: 'supported' as PrfCapability,
  // One function across renders: the page's probe re-runs whenever `navigate` changes.
  navigate: vi.fn(),
  createPasskeyVault: vi.fn(async (): Promise<never> => {
    throw new Error('not reached');
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('./api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://localhost',
}));
vi.mock('./auth-client', () => ({
  getSession: async () => ({ data: { user: { id: 'u1', email: 'alice@example.com' } } }),
}));
vi.mock('./api', () => ({
  vaultApi: { forAccount: () => ({ getUnlockStatus: async () => ({ mode: null }) }) },
}));
vi.mock('./session', () => ({ useVault: () => ({ setSession: vi.fn(), lock: vi.fn() }) }));
vi.mock('./passkey-prf', async importOriginal => ({
  ...(await importOriginal<typeof import('./passkey-prf')>()),
  checkPasskeyPrfCapability: async () => mocks.prf,
}));
vi.mock('./unlock', async importOriginal => ({
  ...(await importOriginal<typeof import('./unlock')>()),
  createPasskeyVault: mocks.createPasskeyVault,
  createPasswordVault: vi.fn(),
}));

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Enrol />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await vi.waitFor(() =>
    expect(host.querySelector('h1')?.textContent).toBe('Choose how you log in'),
  );
  return host;
};

const buttonNamed = (page: HTMLElement, label: string) =>
  [...page.querySelectorAll('button')].find(candidate => candidate.textContent === label);

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  mocks.prf = 'supported';
  vi.clearAllMocks();
});

describe('Enrol', () => {
  it('keeps the password form behind a link while a passkey is on offer, and opens it in place', async () => {
    const page = await mount();
    expect(page.querySelector('#enrol-password')).toBeNull();
    const open = buttonNamed(page, 'Use a password instead');
    if (open === undefined) throw new Error('no "Use a password instead"');

    await act(async () => open.click());
    expect(page.querySelector('#enrol-password')).not.toBeNull();
    expect(document.activeElement?.id).toBe('enrol-password');
    expect(buttonNamed(page, 'Use a password instead')).toBeUndefined();
  });

  it('says why the browser asks twice', async () => {
    const page = await mount();
    expect(page.textContent).toContain('once to create the passkey, once to unlock YOZZ with it');
  });

  it('shows the password form open when this browser cannot use a passkey', async () => {
    mocks.prf = 'unsupported';
    const page = await mount();
    expect(page.querySelector('#enrol-password')).not.toBeNull();
    expect(buttonNamed(page, 'Use a password instead')).toBeUndefined();
  });

  it('opens the password form when the passkey turns out unable to unlock', async () => {
    const { PasskeyPrfError } = await import('./passkey-prf');
    mocks.createPasskeyVault.mockRejectedValueOnce(
      new PasskeyPrfError('This passkey cannot unlock your saved addresses.'),
    );
    const page = await mount();
    const create = buttonNamed(page, 'Create passkey');
    if (create === undefined) throw new Error('no "Create passkey"');

    await act(async () => create.click());
    await vi.waitFor(() => expect(page.querySelector('#enrol-password')).not.toBeNull());
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('Set a password below');
  });

  it('keeps the password form open while it holds what went wrong with it', async () => {
    const page = await mount();
    const open = buttonNamed(page, 'Use a password instead');
    await act(async () => open?.click());
    // Too short: the form says so and stays.
    await act(async () => page.querySelector('form')?.requestSubmit());
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('Use at least');
    expect(page.querySelector('#enrol-password')).not.toBeNull();
  });
});
