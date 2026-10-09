// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const vault = vi.hoisted(() => ({ session: null, isResuming: true }));

vi.mock('../vault/session', () => ({ useVault: () => vault }));

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => <span data-navigate={to} />,
}));

const unmounts: Array<() => Promise<void>> = [];

const mount = async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<AppShell />));
  unmounts.push(() => act(async () => root.unmount()));
  return host;
};

beforeEach(() => {
  // jsdom has no matchMedia; the list's default width steps on one.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(async () => {
  await Promise.all(unmounts.splice(0).map(unmount => unmount()));
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('draws the frame while the vault resumes, and decides nothing yet', async () => {
    vault.isResuming = true;
    const host = await mount();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector('[data-navigate]')).toBeNull();
  });

  it('sends a resume that found no session to /login', async () => {
    vault.isResuming = false;
    const host = await mount();
    expect(host.querySelector('[data-navigate]')?.getAttribute('data-navigate')).toBe('/login');
    expect(host.querySelector('[aria-busy]')).toBeNull();
  });
});
