// @vitest-environment jsdom
import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsHome } from './SettingsHome';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  isWide: true,
  identities: [] as AddressRecord[],
  areAddressesLoaded: true,
}));

vi.mock('../../store/MailProvider', () => ({
  useMail: () => ({ identities: mocks.identities, areAddressesLoaded: mocks.areAddressesLoaded }),
}));
vi.mock('../../ui/chrome', async importOriginal => ({
  ...(await importOriginal<typeof import('../../ui/chrome')>()),
  useMediaQuery: () => mocks.isWide,
}));
vi.mock('./AddAddress', () => ({ AddAddress: () => <p>Add an address</p> }));
vi.mock('@tanstack/react-router', () => ({
  Navigate: ({
    to,
    params,
    replace,
  }: {
    to: string;
    params: { address: string };
    replace: boolean;
  }) => <output data-replace={String(replace)}>{to.replace('$address', params.address)}</output>,
  Link: () => null,
  Outlet: () => null,
  useLocation: () => '/settings',
  useParams: () => ({}),
}));

const SEND_ONLY = { address: 'a-send@example.com', smtp: { host: 'smtp.example.com' } };
const INBOUND = {
  address: 'z-read@example.com',
  imap: { host: 'imap.example.com' },
  smtp: { host: 'smtp.example.com' },
};

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SettingsHome />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  mocks.isWide = true;
  mocks.identities = [];
  mocks.areAddressesLoaded = true;
});

describe('SettingsHome', () => {
  it('opens the first address in the list’s order from `lg`, replacing `/settings`', async () => {
    mocks.identities = [SEND_ONLY, INBOUND] as AddressRecord[];
    const page = await mount();
    const redirect = page.querySelector('output');
    // Reading addresses come first in the list, so the inbound one is first.
    expect(redirect?.textContent).toBe('/settings/a/z-read@example.com');
    expect(redirect?.getAttribute('data-replace')).toBe('true');
    expect(page.textContent).not.toContain('Choose a setting');
  });

  it('stays on the list below `lg`, rendering nothing in the hidden pane', async () => {
    mocks.isWide = false;
    mocks.identities = [INBOUND] as AddressRecord[];
    const page = await mount();
    expect(page.innerHTML).toBe('');
  });

  it('shows nothing while the addresses are still being read', async () => {
    mocks.areAddressesLoaded = false;
    const page = await mount();
    expect(page.innerHTML).toBe('');
  });
});
