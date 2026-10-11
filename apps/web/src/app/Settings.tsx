import { cn } from '@fishballapps/cn';
import { CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type AddressRecord, isInbound } from '../addresses/record';
import { keepCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { SendOnlyTag } from '../ui/SendOnlyTag';

/**
 * A list and the thing you picked from it, the shape the mail already has: every address, adding
 * one, and the account on the left; the selected one on the right. Below `lg` the two show one at a
 * time, the list at `/settings` and a pane at any route under it.
 */

const hostsOf = (record: AddressRecord): string =>
  isInbound(record) ? `${record.imap.host} · ${record.smtp.host}` : record.smtp.host;

/** Reading addresses first, in the rail's order, then the send-only ones. */
export const byRole = (a: AddressRecord, b: AddressRecord): number =>
  Number(isInbound(b)) - Number(isInbound(a));

const NavRow = ({
  isActive,
  children,
  ...link
}: {
  isActive: boolean;
  children: ReactNode;
} & (
  | { to: '/settings/a/$address'; params: { address: string } }
  | { to: '/settings/new' | '/settings/account'; params?: never }
)) => (
  <li>
    <Link
      {...link}
      search={keepCompose}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative grid min-h-11 grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-3 py-2.5 pr-3 pl-5 transition-colors lg:grid-cols-[minmax(0,1fr)_auto] lg:py-2',
        isActive ? 'bg-ink-hover text-paper' : 'text-paper-dim hover:bg-ink-hover/60',
      )}
    >
      {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      {children}
      <CaretRightIcon size={12} className="text-paper-faint lg:hidden" />
    </Link>
  </li>
);

const SettingsNav = () => {
  const { identities } = useMail();
  const { pathname } = useLocation();
  const { address: selected } = useParams({ strict: false });

  return (
    <>
      {/* A phone's top bar already names the screen. */}
      <h1 className="px-5 pt-8 pb-6 text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper max-lg:sr-only">
        Settings
      </h1>

      <h2 className="label-rule px-5 pt-6 pb-2 lg:pt-0">Addresses</h2>
      <ul className="border-t border-rule-soft">
        {[...identities].sort(byRole).map(record => (
          <NavRow
            key={record.address}
            to="/settings/a/$address"
            params={{ address: record.address }}
            isActive={record.address === selected}
          >
            <span className="min-w-0">
              <span className="block truncate text-base">{record.address}</span>
              <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
                {hostsOf(record)}
              </span>
            </span>
            {isInbound(record) ? <span /> : <SendOnlyTag />}
          </NavRow>
        ))}
        <NavRow to="/settings/new" isActive={pathname === '/settings/new'}>
          <span className="flex items-center gap-2 text-base">
            <PlusIcon size={13} className="text-paper-faint" />
            Add an address
          </span>
          <span />
        </NavRow>
      </ul>

      <h2 className="label-rule px-5 pt-8 pb-2">Account</h2>
      <ul className="border-t border-rule-soft pb-8">
        <NavRow to="/settings/account" isActive={pathname === '/settings/account'}>
          <span className="min-w-0">
            <span className="block truncate text-base">Sign-in and vault</span>
            <span className="mt-0.5 block truncate text-2xs text-paper-faint">
              Passkeys, sign out, reset
            </span>
          </span>
          <span />
        </NavRow>
      </ul>
    </>
  );
};

export const Settings = () => {
  // The bare list is a phone's whole screen; anywhere under it, the pane is.
  const isPaneOpen = useLocation({ select: location => location.pathname !== '/settings' });

  return (
    <main className="flex min-w-0 flex-1">
      <nav
        aria-label="Settings"
        className={cn(
          'min-w-0 flex-col overflow-y-auto border-rule-soft bg-ink lg:flex lg:w-72 lg:flex-none lg:border-r',
          isPaneOpen ? 'hidden' : 'flex flex-1',
        )}
      >
        <SettingsNav />
      </nav>
      <section
        className={cn(
          'min-w-0 flex-1 overflow-y-auto bg-ink-sunken',
          isPaneOpen ? 'block' : 'hidden lg:block',
        )}
      >
        <div className="max-w-2xl px-5 py-8 sm:px-8 lg:px-10">
          <Outlet />
        </div>
      </section>
    </main>
  );
};
