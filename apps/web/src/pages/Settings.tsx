import { cn } from '@fishballapps/cn';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { PageColumn } from '../components/PageColumn';
import { keepCompose } from '../lib/compose';

/** Two routes under one layout, so a section is linkable. */

const TABS = [
  {
    to: '/settings',
    label: 'Addresses',
    // An address's own page is still the Addresses section.
    isActive: (pathname: string) => !pathname.startsWith('/settings/vault'),
  },
  {
    to: '/settings/vault',
    label: 'Vault',
    isActive: (pathname: string) => pathname.startsWith('/settings/vault'),
  },
] as const;

export const Settings = () => {
  const { pathname } = useLocation();

  return (
    <PageColumn
      title="Settings"
      nav={
        <nav
          aria-label="Settings sections"
          className="mt-5 flex items-center gap-5 border-b border-rule-soft"
        >
          {TABS.map(tab => {
            const isActive = tab.isActive(pathname);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                search={keepCompose}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'label-rule -mb-px border-b-2 py-3.5 transition-colors hover:text-paper lg:py-2.5',
                  isActive ? 'border-signal text-paper' : 'border-transparent',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      }
    >
      <Outlet />
    </PageColumn>
  );
};
