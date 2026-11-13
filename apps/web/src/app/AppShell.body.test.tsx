// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  pathname: '/m/unified',
  title: 'Inbox' as string | undefined,
  listing: {} as object | undefined,
  isWide: true,
  mail: {
    identities: [{ address: 'me@example.com' }] as { address: string }[],
    areAddressesLoaded: true,
  },
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: {}, isResuming: false }) }));
vi.mock('../store/MailProvider', () => ({ useMail: () => state.mail }));
vi.mock('../threads/use-listing', () => ({
  useListing: () => state.listing,
  useSearchFollowsUrl: () => {},
}));
vi.mock('../threads/SearchRow', () => ({
  SearchRow: ({ leading, trailing }: { leading?: ReactNode; trailing?: ReactNode }) => (
    <div data-search-row>
      {leading}
      {trailing}
    </div>
  ),
}));
vi.mock('../addresses/AddressRail', () => ({ AddressRail: () => <nav data-rail /> }));
vi.mock('../agent/AgentTools', () => ({ AgentTools: () => null }));
vi.mock('./ActivityBar', () => ({ ActivityBar: () => null }));
vi.mock('./settings/AddAddress', () => ({
  AddAddress: ({ isFirst }: { isFirst?: boolean }) => <div data-add-address={String(isFirst)} />,
}));
vi.mock('@tanstack/react-router', () => ({
  Navigate: () => null,
  Outlet: () => null,
  Link: ({
    children,
    to,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    to: string;
    'aria-label'?: string;
  }) => (
    <a href="https://yozz.test" data-to={to} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: state.pathname }),
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) =>
    select([{ staticData: state.title === undefined ? {} : { title: state.title } }]),
  useParams: () => ({}),
}));

const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
const show = (path: string, init: Partial<typeof state> = {}) => {
  Object.assign(state, { pathname: path }, init);
  return act(async () => root.render(<AppShell />));
};
const compose = () => host.querySelector('a[aria-label="Compose"]');

beforeEach(() => {
  Object.assign(state, {
    pathname: '/m/unified',
    title: 'Inbox',
    listing: {},
    isWide: true,
    mail: { identities: [{ address: 'me@example.com' }], areAddressesLoaded: true },
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('64rem') ? state.isWide : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(async () => {
  await act(async () => root.render(null));
  vi.unstubAllGlobals();
});

describe('AppShell, past the vault', () => {
  describe('Skip to mail', () => {
    it('is the first thing a keyboard reaches, and moves focus to the list', async () => {
      await show('/m/unified');
      const first = host.querySelector('button, a, [tabindex]');
      expect(first?.textContent).toBe('Skip to mail');

      const list = document.body.appendChild(document.createElement('div'));
      list.id = 'mail';
      list.tabIndex = -1;
      await act(async () => (first as HTMLElement).click());
      expect(document.activeElement).toBe(list);
      list.remove();
    });

    it('is not offered where there is no list', async () => {
      await show('/settings', { listing: undefined });
      expect(host.textContent).not.toContain('Skip to mail');
    });
  });

  describe('Compose before and after an address', () => {
    it('opens the composer once there is an address, and Settings before', async () => {
      await show('/m/unified', { isWide: false });
      expect(compose()?.getAttribute('data-to')).toBe('.');
      await show('/m/unified', {
        isWide: false,
        mail: { identities: [], areAddressesLoaded: true },
      });
      expect(compose()?.getAttribute('data-to')).toBe('/settings/new');
    });

    it('does not send anyone to Settings while their addresses are still loading', async () => {
      await show('/m/unified', {
        isWide: false,
        mail: { identities: [], areAddressesLoaded: false },
      });
      expect(compose()?.getAttribute('data-to')).toBe('.');
    });
  });

  describe('the first address', () => {
    const none = { identities: [], areAddressesLoaded: true };

    it.each(['/settings', '/settings/new', '/settings/'])(
      'stands alone, with no rail or bar, at %s once the addresses are loaded and none',
      async path => {
        await show(path, { mail: none, title: 'Settings' });
        expect(host.querySelector('[data-add-address="true"]')).not.toBeNull();
        expect(host.querySelector('[data-rail]')).toBeNull();
        expect(host.querySelector('nav')).toBeNull();
        expect(compose()).toBeNull();
      },
    );

    it('never shows while the addresses are still loading', async () => {
      await show('/settings/new', {
        mail: { identities: [], areAddressesLoaded: false },
        title: 'Settings',
      });
      expect(host.querySelector('[data-add-address]')).toBeNull();
      expect(host.querySelector('[data-rail]')).not.toBeNull();
    });

    it('is the shell everywhere else, and once an address exists', async () => {
      await show('/m/unified', { mail: none });
      expect(host.querySelector('[data-add-address]')).toBeNull();
      expect(host.querySelector('[data-rail]')).not.toBeNull();
      await show('/settings/account', { mail: none, title: 'Account' });
      expect(host.querySelector('[data-add-address]')).toBeNull();
      await show('/settings/new', {
        title: 'Settings',
        mail: { identities: [{ address: 'me@example.com' }], areAddressesLoaded: true },
      });
      expect(host.querySelector('[data-add-address]')).toBeNull();
    });
  });

  describe('the top bar below lg, off the mail', () => {
    const bar = () => host.querySelector('.border-b');

    it('names the page in the title voice, with the navigation button', async () => {
      await show('/settings', { isWide: false, listing: undefined, title: 'Settings' });
      const title = [...host.querySelectorAll('span')].find(
        span => span.textContent === 'Settings',
      );
      expect(title?.className).toContain('text-[15px]');
      expect(title?.className).toContain('font-medium');
      expect(title?.className).not.toContain('uppercase');
      expect(host.querySelector('button[aria-label="Open navigation"]')).not.toBeNull();
      expect(host.querySelector('a[aria-label="Back to Settings"]')).toBeNull();
      expect(bar()).not.toBeNull();
    });

    it('puts a way back to Settings where the navigation button was, on a sub-page', async () => {
      await show('/settings/images', { isWide: false, listing: undefined, title: 'Images' });
      expect(host.querySelector('a[aria-label="Back to Settings"]')?.getAttribute('data-to')).toBe(
        '/settings',
      );
      expect(host.querySelector('button[aria-label="Open navigation"]')).toBeNull();
      expect(host.textContent).toContain('Images');
    });
  });
});
