// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressRail } from './AddressRail';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ view: 'unified' as string | undefined }));
const mail = vi.hoisted(() => ({
  mailboxes: [{ address: 'me@example.com' }],
  identities: [{ address: 'me@example.com' }] as { address: string }[],
  areAddressesLoaded: true,
  threads: [],
  sync: vi.fn(),
  junkFolders: {} as Record<string, boolean>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    onClick,
    to,
    'aria-label': ariaLabel,
    'aria-current': ariaCurrent,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    to?: string;
    'aria-label'?: string;
    'aria-current'?: 'page';
  }) => (
    <a
      href="https://yozz.test"
      onClick={onClick}
      data-to={to}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
    >
      {children}
    </a>
  ),
  useSearch: () => ({}),
  useParams: () => ({ view: route.view }),
  useLocation: () => false,
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
const show = () => act(async () => root.render(<AddressRail />));
const click = (name: string) => {
  const row = [...host.querySelectorAll('a')].find(link => link.textContent?.startsWith(name));
  if (row === undefined) throw new Error(`No ${name} row`);
  return act(async () => row.click());
};

afterEach(async () => {
  await act(async () => root.render(null));
  mail.sync.mockClear();
  mail.junkFolders = {};
  mail.identities = [{ address: 'me@example.com' }];
  mail.mailboxes = [{ address: 'me@example.com' }];
  mail.areAddressesLoaded = true;
});

describe('AddressRail', () => {
  it('syncs every address when the open Inbox is clicked again', async () => {
    route.view = 'unified';
    await show();
    await click('Inbox');
    expect(mail.sync).toHaveBeenCalledWith(undefined);
  });

  it('syncs one address when its open row is clicked again', async () => {
    route.view = 'me@example.com';
    await show();
    await click('me@example.com');
    expect(mail.sync).toHaveBeenCalledWith('me@example.com');
  });

  it('only opens a view that is not the open one', async () => {
    route.view = 'unified';
    await show();
    await click('me@example.com');
    expect(mail.sync).not.toHaveBeenCalled();
  });

  it('shows Junk only once a server has listed one, since YOZZ never creates it', async () => {
    route.view = 'unified';
    const labels = () => [...host.querySelectorAll('a')].map(link => link.textContent);
    await show();
    expect(labels()).not.toContain('Junk');
    mail.junkFolders = { 'me@example.com': true };
    await show();
    expect(labels()).toContain('Junk');
  });

  it('says how many addresses only send, which have no row of their own', async () => {
    await show();
    expect(host.textContent).not.toContain('send-only');

    mail.identities = [
      { address: 'me@example.com' },
      { address: 'sales@example.com' },
      { address: 'billing@example.com' },
    ];
    await show();
    expect(host.textContent).toContain('+2 send-only');
  });

  it('names the send-only line as the link it is', async () => {
    mail.identities = [{ address: 'me@example.com' }, { address: 'sales@example.com' }];
    await show();
    const link = [...host.querySelectorAll('a')].find(a => a.textContent === '+1 send-only');
    expect(link?.getAttribute('aria-label')).toBe('1 send-only address, manage in Settings');
    expect(link?.getAttribute('data-to')).toBe('/settings');
  });

  describe('a fresh account', () => {
    const link = (text: string) =>
      [...host.querySelectorAll('a')].find(a => a.textContent === text);

    it('offers to connect an address under Addresses, and sends Compose to the same place', async () => {
      mail.identities = [];
      mail.mailboxes = [];
      await show();
      expect(link('Connect an address')?.getAttribute('data-to')).toBe('/settings/new');
      expect(link('Compose')?.getAttribute('data-to')).toBe('/settings/new');
    });

    it('opens the composer, and offers no such row, once there is an address', async () => {
      await show();
      expect(link('Connect an address')).toBeUndefined();
      expect(link('Compose')?.getAttribute('data-to')).toBe('.');
    });

    it('says nothing of it while the addresses are still being read', async () => {
      mail.identities = [];
      mail.mailboxes = [];
      mail.areAddressesLoaded = false;
      await show();
      expect(link('Connect an address')).toBeUndefined();
      expect(link('Compose')?.getAttribute('data-to')).toBe('.');
    });
  });
});
