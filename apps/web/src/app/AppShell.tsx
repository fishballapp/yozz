import { Dialog } from '@base-ui/react/dialog';
import { ListIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { Link, Navigate, Outlet, useMatches } from '@tanstack/react-router';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { AddressRail } from '../addresses/AddressRail';
import { AgentTools } from '../agent/AgentTools';
import { withCompose } from '../compose/intent';
import { SearchRow } from '../threads/SearchRow';
import { useListing, useSearchFollowsUrl } from '../threads/use-listing';
import { Button, buttonClass } from '../ui/Button';
import { isDemo, useMediaQuery } from '../ui/chrome';
import { RAIL_WIDTH, Resizer, useListWidth, useRailWidth } from '../ui/Resizer';
import { Wordmark } from '../ui/Wordmark';
import { useVault } from '../vault/session';
import { ActivityBar } from './ActivityBar';

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
  const compose = (
    <Link
      to="."
      search={withCompose('new')}
      aria-label="Compose"
      className={cn(buttonClass({ variant: 'primary', size: 'icon' }), 'm-2 shrink-0')}
    >
      <PlusIcon size={12} weight="bold" />
    </Link>
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

  const pageTitle = useMatches({
    select: matches => matches.findLast(match => match.staticData.title !== undefined)?.staticData,
  })?.title;

  const listing = useListing();
  // Lowercased at this seam, as the bar sets it in tracked-out capitals.
  const title = pageTitle?.toLowerCase() ?? '';

  return (
    <div className="flex h-dvh flex-col bg-ink">
      <ActivityBar />
      {/* One bar for every screen below `lg`. Compose belongs on it everywhere, not only over the
          mail: on a wide screen the rail carries it on every route, and a phone that loses it the
          moment you open Settings is the desktop app minus a button for no reason. Over the mail it
          holds the search row, since the box already says where you are. */}
      {!isWide &&
        (listing === undefined ? (
          <div className="flex shrink-0 items-start border-b border-rule-soft bg-ink-raised">
            {openRail}
            <span className="min-w-0 flex-1 self-center truncate font-mono text-2xs tracking-[0.08em] text-paper-dim uppercase">
              {title}
            </span>
            {compose}
          </div>
        ) : (
          <SearchRow listing={listing} leading={openRail} trailing={compose} />
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
            className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col outline-none transition-transform duration-150 data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full lg:hidden"
            aria-label="Navigation"
          >
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-3 right-2 z-10 size-11 lg:size-7"
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
