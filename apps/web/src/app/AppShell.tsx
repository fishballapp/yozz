import { Dialog } from '@base-ui/react/dialog';
import { CaretLeftIcon, ListIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { Link, Navigate, Outlet, useLocation, useMatches, useParams } from '@tanstack/react-router';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { AddressRail } from '../addresses/AddressRail';
import { AgentTools } from '../agent/AgentTools';
import { keepCompose, withCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { SearchRow } from '../threads/SearchRow';
import { useListing, useSearchFollowsUrl } from '../threads/use-listing';
import { Button, buttonClass } from '../ui/Button';
import { isDemo, useMediaQuery } from '../ui/chrome';
import { RAIL_WIDTH, Resizer, useListWidth, useRailWidth } from '../ui/Resizer';
import { Tooltip } from '../ui/Tooltip';
import { Wordmark } from '../ui/Wordmark';
import { useVault } from '../vault/session';
import { ActivityBar } from './ActivityBar';
import { AddAddress } from './settings/AddAddress';

/**
 * A pathless layout route (`routes/_app.tsx`), so the rail mounts once; anything that renders
 * without the app is a sibling route. The vault gate sits here because `beforeLoad` cannot read
 * React context.
 */
export const AppShell = () => {
  const { session, isResuming } = useVault();
  if (isResuming && !isDemo()) return <AppShellSkeleton />;
  if (session === null && !isDemo()) {
    return <Navigate to="/login" replace />;
  }
  return <AppShellBody />;
};

/**
 * The shell's frame while a reload resumes the vault: its bars, rules and stored pane widths with
 * nothing in them, so the cached list lands in place instead of onto a blank page.
 */
const AppShellSkeleton = () => {
  const [railWidth] = useRailWidth();
  const [listWidth] = useListWidth();

  return (
    <div className="flex h-dvh flex-col bg-ink" aria-busy>
      <div className="h-11 shrink-0 border-b border-rule-soft bg-ink-raised lg:hidden" />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden shrink-0 bg-ink-raised lg:block" style={{ width: railWidth }}>
          <div className="px-3 pt-4 pb-3">
            <span className="inline-flex text-paper">
              <Wordmark className="h-3.5 w-auto" />
            </span>
          </div>
        </aside>
        <div className="hidden w-px shrink-0 bg-rule-soft lg:block" />
        <div style={{ width: listWidth }} className="min-w-0 flex-1 lg:min-w-80 lg:flex-initial">
          <div className="h-11 border-b border-rule-soft" />
        </div>
        <div className="hidden w-px shrink-0 bg-rule-soft lg:block" />
        <div className="hidden min-w-0 flex-1 bg-ink-sunken lg:block lg:min-w-80" />
      </div>
    </div>
  );
};

const AppShellBody = () => {
  const [isRailOpen, setIsRailOpen] = useState(false);
  const [railWidth, setRailWidth, resetRailWidth] = useRailWidth();
  const isWide = useMediaQuery('(min-width: 64rem)');
  const openRail = (
    <Button
      variant="ghost"
      size="icon"
      // Over the rows' star column, so what follows it starts on their sender column.
      className="mr-2 ml-1 size-11 shrink-0"
      onClick={() => setIsRailOpen(true)}
      aria-label="Open navigation"
    >
      <ListIcon size={16} />
    </Button>
  );
  const { identities, areAddressesLoaded } = useMail();
  const pathname = useLocation({ select: location => location.pathname.replace(/\/$/u, '') });
  // Only once they have loaded: an account whose addresses are still being read has not none.
  const hasNoAddress = areAddressesLoaded && identities.length === 0;
  const isFirstAddress = hasNoAddress && (pathname === '/settings' || pathname === '/settings/new');
  const isSettingsSubPage = pathname.startsWith('/settings/');
  const composeClass = cn(buttonClass({ variant: 'primary', size: 'icon' }), 'm-2 shrink-0');
  // A composer with no address to send from is a dead end, so until one exists it opens the way to one.
  const compose = (
    <Tooltip label="Compose">
      {hasNoAddress ? (
        <Link to="/settings/new" search={keepCompose} aria-label="Compose" className={composeClass}>
          <PlusIcon size={12} weight="bold" />
        </Link>
      ) : (
        <Link to="." search={withCompose('new')} aria-label="Compose" className={composeClass}>
          <PlusIcon size={12} weight="bold" />
        </Link>
      )}
    </Tooltip>
  );

  // Base UI's modal aria-hides the rest of the app while open; crossing `lg` with the sheet open
  // left the whole app hidden behind a display:none popup.
  useEffect(() => {
    const wide = matchMedia('(min-width: 64rem)');
    const close = () => {
      if (wide.matches) setIsRailOpen(false);
    };
    close();
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, []);

  useSearchFollowsUrl();

  const staticTitle = useMatches({
    select: matches => matches.findLast(match => match.staticData.title !== undefined)?.staticData,
  })?.title;

  const listing = useListing();
  const { _splat: openThread, address } = useParams({ strict: false });
  // An address's own page is titled by the address, which no static title can hold.
  const pageTitle = address ?? staticTitle;

  // With no address stored, adding one is all there is to do, and the rail and bars would offer
  // views that cannot hold mail. It stands alone, as the sign-in steps before it do.
  if (isFirstAddress) return <AddAddress isFirst />;

  const goBack = (
    <Tooltip label="Settings" side="bottom">
      <Link
        to="/settings"
        search={keepCompose}
        aria-label="Back to Settings"
        className={cn(
          buttonClass({ variant: 'ghost', size: 'icon' }),
          'mr-2 ml-1 size-11 shrink-0',
        )}
      >
        <CaretLeftIcon size={16} />
      </Link>
    </Tooltip>
  );

  return (
    <div className="flex h-dvh flex-col bg-ink">
      {/* The first thing a keyboard reaches: the rail and the box are many tab stops before the
          first row. Over the mail only, where there is a list to skip to. */}
      {listing !== undefined && (
        <button
          type="button"
          // Not an in-page anchor: the router would take the hash for a navigation.
          onClick={() => document.getElementById('mail')?.focus()}
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:bg-ink-raised focus:px-3 focus:py-2 focus:text-base focus:text-paper"
        >
          Skip to mail
        </button>
      )}
      <ActivityBar />
      {/* One bar for every screen below `lg`. Compose belongs on it everywhere, not only over the
          mail: on a wide screen the rail carries it on every route, and a phone that loses it the
          moment you open Settings is the desktop app minus a button for no reason. Over the mail it
          holds the search row, whose box says where you are. While a message is open the reader's
          own bar is the top bar: this one is hidden, not unmounted, so the search row still knows
          which view its search began from when the message closes. */}
      {!isWide &&
        (listing === undefined ? (
          <div className="flex shrink-0 items-start border-b border-rule-soft bg-ink-raised">
            {isSettingsSubPage ? goBack : openRail}
            <span className="min-w-0 flex-1 self-center truncate text-[15px] font-medium text-paper">
              {pageTitle ?? ''}
            </span>
            {compose}
          </div>
        ) : (
          <div className={cn('shrink-0', openThread !== undefined && 'hidden')}>
            <SearchRow listing={listing} leading={openRail} trailing={compose} />
          </div>
        ))}

      {/* `relative`: below `lg` an open message lies over the list (`ViewPage`). */}
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden shrink-0 lg:block" style={{ width: railWidth }}>
          <AddressRail />
        </aside>

        <Resizer
          label="Navigation width"
          width={railWidth}
          min={RAIL_WIDTH.min}
          max={RAIL_WIDTH.max}
          onResize={setRailWidth}
          onReset={resetRailWidth}
        />

        <Outlet />
      </div>

      <AgentTools />

      <Dialog.Root open={isRailOpen} onOpenChange={setIsRailOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 lg:hidden" />
          <Dialog.Popup
            className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col outline-none transition-transform duration-150 data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full lg:hidden"
            aria-label="Navigation"
          >
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  // Centred on the wordmark's row.
                  className="absolute top-px right-1 z-10 size-11"
                  aria-label="Close navigation"
                >
                  <XIcon size={15} />
                </Button>
              }
            />
            <AddressRail onNavigate={() => setIsRailOpen(false)} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
