import { Dialog } from '@base-ui/react/dialog';
import { ListIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { Link, Navigate, Outlet, useMatches, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { isDemo, usePaneWidth } from '../lib/chrome';
import { withCompose } from '../lib/compose';
import { mailboxLabel, useMail, visibleThreads } from '../state/mail';
import { useVault } from '../vault/session';
import { AddressRail } from './AddressRail';
import { RAIL_WIDTH, Resizer } from './Resizer';
import { StatusBar } from './StatusBar';
import { Button, buttonClass } from './ui/Button';

/**
 * Everything that is true on every screen: the rail, its resizer, the mobile top bar and sheet, and
 * the status line across the foot. Routes fill the space between the rail and the status line.
 *
 * It is a pathless LAYOUT ROUTE (`routes/_app.tsx`), not a component pages opt into, and that is
 * the whole point: the rail is mounted once and stays mounted across every navigation. When two
 * pages each rendered their own copy of this, the rail unmounted and remounted on the way to
 * Settings, and the only thing keeping its dragged width was that both copies happened to read the
 * same `localStorage` key. Now it is one object, so it keeps its width because it never went away.
 *
 * Being a position in the route tree also decides what is NOT here: anything that should render
 * without the app around it — a message opened on its own in a new tab — is a sibling of this
 * route rather than a child, and gets the bare page for free.
 *
 * The vault gate sits here rather than in a route loader: `beforeLoad` cannot read React context.
 * While the provider is resuming a persisted unlock it renders nothing, so a reload does not
 * flash `/login` on its way back to the mailbox.
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

  // The sheet is only rendered below `lg`, but Base UI's modal dialog aria-hides the rest of the
  // app and traps focus for as long as it is OPEN. Crossing the breakpoint with it open (a
  // rotation, a window drag) left the whole app hidden behind a display:none popup.
  useEffect(() => {
    const wide = matchMedia('(min-width: 64rem)');
    const close = () => {
      if (wide.matches) setIsRailOpen(false);
    };
    close();
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, []);

  // `strict: false` because this route has neither: it sits above every page and reads whichever of
  // them is currently matched. A mailbox names itself from the URL; a page states its name up front.
  const { mailbox } = useParams({ strict: false });
  const { q } = useSearch({ strict: false });
  const pageTitle = useMatches({
    select: matches => matches.findLast(match => match.staticData.title !== undefined)?.staticData,
  })?.title;

  // The status line counts what the list is SHOWING, search included — the same derivation the list
  // itself runs, from one function, so the two can never disagree about how many messages are there.
  const visible = mailbox === undefined ? undefined : visibleThreads(threads, mailbox, q);
  const counts =
    visible === undefined
      ? undefined
      : { unread: visible.filter(thread => thread.isUnread).length, total: visible.length };

  // Page titles are lowercased at this seam so the slot reads the same whatever fills it — mailbox
  // labels are already lowercase (`inbox`, an address), and `Settings` beside them was the odd one.
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
