import { Dialog } from '@base-ui/react/dialog';
import { ListIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { Link, Navigate, Outlet, useMatches, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AgentTools } from '../agent/AgentTools';
import { JudgeBanner } from '../judge/JudgeBanner';
import { isDemo, usePaneWidth } from '../lib/chrome';
import { withCompose } from '../lib/compose';
import { mailboxLabel, useMail, visibleThreads } from '../state/mail';
import { useVault } from '../vault/session';
import { AddressRail } from './AddressRail';
import { RAIL_WIDTH, Resizer } from './Resizer';
import { StatusBar } from './StatusBar';
import { Button, buttonClass } from './ui/Button';

/**
 * A pathless layout route (`routes/_app.tsx`), so the rail mounts once; anything that renders
 * without the app is a sibling route. The vault gate sits here because `beforeLoad` cannot read
 * React context; while a persisted unlock resumes it renders nothing.
 */
export const AppShell = () => {
  const { session, isResuming } = useVault();
  if (isResuming && !isDemo()) return null;
  if (session === null && !isDemo()) {
    return <Navigate to="/login" replace />;
  }
  return <AppShellBody />;
};

const AppShellBody = () => {
  const { threads } = useMail();
  const [isRailOpen, setIsRailOpen] = useState(false);
  const [railWidth, setRailWidth, resetRailWidth] = usePaneWidth(
    'yozz:rail-width',
    RAIL_WIDTH.base,
    RAIL_WIDTH.min,
    RAIL_WIDTH.max,
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

  // `strict: false`: this sits above every page and reads whichever is matched.
  const { mailbox } = useParams({ strict: false });
  const { q } = useSearch({ strict: false });
  const pageTitle = useMatches({
    select: matches => matches.findLast(match => match.staticData.title !== undefined)?.staticData,
  })?.title;

  // The same derivation the list runs, from one function.
  const visible = mailbox === undefined ? undefined : visibleThreads(threads, mailbox, q);
  const counts =
    visible === undefined
      ? undefined
      : { unread: visible.filter(thread => thread.isUnread).length, total: visible.length };

  // Lowercased at this seam: mailbox labels already are.
  const title = mailbox === undefined ? (pageTitle?.toLowerCase() ?? '') : mailboxLabel(mailbox);

  return (
    <div className="flex h-dvh flex-col bg-ink">
      {/* One bar for every screen. Compose belongs on it everywhere, not only over the mail: on a
          wide screen the rail carries it on every route, and a phone that loses it the moment you
          open Settings is the desktop app minus a button for no reason. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-rule-soft bg-ink-raised pr-2 pl-1 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 lg:size-7"
          onClick={() => setIsRailOpen(true)}
          aria-label="Open mailboxes"
        >
          <ListIcon size={16} />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs tracking-[0.08em] text-paper-dim uppercase">
          {title}
        </span>
        <Link
          to="."
          search={withCompose('new')}
          className={buttonClass({ variant: 'primary', size: 'sm' })}
        >
          <PlusIcon size={12} weight="bold" />
          Compose
        </Link>
      </div>

      <JudgeBanner />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden shrink-0 lg:block" style={{ width: railWidth }}>
          <AddressRail />
        </aside>

        <Resizer
          label="Mailbox rail width"
          width={railWidth}
          min={RAIL_WIDTH.min}
          max={RAIL_WIDTH.max}
          onResize={setRailWidth}
          onReset={resetRailWidth}
        />

        <Outlet />
      </div>

      <StatusBar title={title} counts={counts} />
      <AgentTools />

      <Dialog.Root open={isRailOpen} onOpenChange={setIsRailOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 lg:hidden" />
          <Dialog.Popup
            className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col outline-none transition-transform duration-150 data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full lg:hidden"
            aria-label="Mailboxes"
          >
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-3 right-2 z-10 size-11 lg:size-7"
                  aria-label="Close mailboxes"
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
