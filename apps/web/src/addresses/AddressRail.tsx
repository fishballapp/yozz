import {
  ArchiveIcon,
  GearIcon,
  MailboxIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react';
import { Link, useLocation, useParams, useSearch } from '@tanstack/react-router';
import { isNamedView, unreadCount, type ViewId, viewShown } from '@yozz.app/mail/threads/views';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { keepCompose, withCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { nameOfView } from '../threads/view-name';
import { buttonClass } from '../ui/Button';
import { Wordmark } from '../ui/Wordmark';

/**
 * Address-first (PRODUCT.md principle 2), so connecting an address lives in Settings. The Inbox
 * row's id stays `unified` (DECISIONS.md), and every link uses `keepCompose`.
 */

/**
 * A rail row's click opens its view, or, on the view already open, syncs what it shows: every
 * address for a view, one for an address, as Gmail does. The activity bar says it happened.
 */
const useRowClick = (view: ViewId, onNavigate: (() => void) | undefined) => {
  const params = useParams({ strict: false });
  const { q } = useSearch({ strict: false });
  const { sync, mailboxes } = useMail();
  // A search is no row's list, so none lights up over it.
  const isActive = params.view !== undefined && viewShown(params.view, q, mailboxes) === view;
  return {
    isActive,
    onClick: () => {
      if (isActive) void sync(isNamedView(view) ? undefined : view);
      onNavigate?.();
    },
  };
};

const UnifiedRow = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { threads } = useMail();
  const { isActive, onClick } = useRowClick('unified', onNavigate);
  const unread = unreadCount(threads, 'unified');

  return (
    <Link
      to="/m/$view"
      params={{ view: 'unified' }}
      search={keepCompose}
      onClick={onClick}
      // The router marks any link to this path current, which a search on it is not.
      activeOptions={{ exact: true }}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative mx-2 mb-1 flex h-11 items-center gap-2.5 px-2.5 transition-colors',
        isActive ? 'bg-ink-hover text-paper' : 'text-paper-dim hover:bg-ink-hover/60',
      )}
    >
      {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      <MailboxIcon size={16} className={isActive ? 'text-paper' : 'text-paper-faint'} />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium tracking-[-0.01em]">
        {nameOfView('unified')}
      </span>
      {unread > 0 && (
        <span className="shrink-0 bg-signal px-1.5 py-px font-mono text-2xs font-medium text-signal-ink">
          {unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
    </Link>
  );
};

const RailRow = ({
  view,
  mark,
  label,
  count,
  onNavigate,
}: {
  view: ViewId;
  /** A view's icon. An address row has none: the address is its own label. */
  mark?: ReactNode;
  label: string;
  count?: number;
  onNavigate?: () => void;
}) => {
  const { isActive, onClick } = useRowClick(view, onNavigate);

  return (
    <Link
      to="/m/$view"
      params={{ view }}
      search={keepCompose}
      onClick={onClick}
      // The router marks any link to this path current, which a search on it is not.
      activeOptions={{ exact: true }}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2.5 py-1.5 pr-2.5 pl-3 text-base transition-colors',
        isActive ? 'bg-ink-hover text-paper' : 'text-paper-dim hover:bg-ink-hover/60',
      )}
    >
      {/* One signal hit per active row: the edge bar. The icon stays neutral — spending the
          accent on bar + icon + count at once is how an accent stops meaning anything. */}
      {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      {mark !== undefined && (
        <span
          aria-hidden
          className={cn(
            'flex w-4 shrink-0 justify-center',
            isActive ? 'text-paper' : 'text-paper-faint',
          )}
        >
          {mark}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
      </span>
      {count !== undefined && count > 0 && (
        <span className="shrink-0 font-mono text-2xs text-signal">
          {count}
          <span className="sr-only"> unread</span>
        </span>
      )}
    </Link>
  );
};

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="label-rule px-3 pt-4 pb-1.5">{children}</p>
);

export const AddressRail = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { mailboxes, identities, areAddressesLoaded, threads, isDemo, junkFolders } = useMail();
  const sendOnlyCount = identities.length - mailboxes.length;
  // Not before they load: an account whose addresses are still being read has not none.
  const hasNoAddress = areAddressesLoaded && identities.length === 0;
  const isSettings = useLocation({ select: location => location.pathname.startsWith('/settings') });

  return (
    <nav className="flex h-full flex-col bg-ink-raised" aria-label="Navigation">
      <div className="px-3 pt-4 pb-3">
        <Link
          to="/m/$view"
          params={{ view: 'unified' }}
          search={keepCompose}
          onClick={onNavigate}
          // The router marks any link to this path current, which a search on it is not.
          activeOptions={{ exact: true }}
          className="inline-flex text-paper"
        >
          <Wordmark className="h-3.5 w-auto" />
        </Link>
      </div>

      <div className="px-3 pb-3">
        {/* The mobile sheet is a modal; left open behind the composer it traps focus. With no
            address to send from, the composer is a dead end, so it opens the way to one instead. */}
        {hasNoAddress ? (
          <Link
            to="/settings/new"
            search={keepCompose}
            onClick={onNavigate}
            className={cn(buttonClass({ variant: 'primary' }), 'w-full justify-start gap-2')}
          >
            <PlusIcon size={14} weight="bold" />
            Compose
          </Link>
        ) : (
          <Link
            to="."
            search={withCompose('new')}
            onClick={onNavigate}
            className={cn(buttonClass({ variant: 'primary' }), 'w-full justify-start gap-2')}
          >
            <PlusIcon size={14} weight="bold" />
            Compose
          </Link>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <UnifiedRow onNavigate={onNavigate} />

        <SectionLabel>Addresses</SectionLabel>
        {mailboxes.map(mailbox => (
          <RailRow
            key={mailbox.address}
            view={mailbox.address}
            label={mailbox.address}
            count={unreadCount(threads, mailbox.address)}
            onNavigate={onNavigate}
          />
        ))}
        {hasNoAddress && (
          <Link
            to="/settings/new"
            search={keepCompose}
            onClick={onNavigate}
            className="flex items-center gap-2.5 py-1.5 pr-2.5 pl-3 text-base text-paper-dim transition-colors hover:bg-ink-hover/60 hover:text-paper"
          >
            <span aria-hidden className="flex w-4 shrink-0 justify-center text-paper-faint">
              <PlusIcon size={13} />
            </span>
            Connect an address
          </Link>
        )}
        {/* A send-only address has no list to open, so no row: one line says they exist, and
            reads as the link it is. */}
        {sendOnlyCount > 0 && (
          <Link
            to="/settings"
            search={keepCompose}
            onClick={onNavigate}
            aria-label={`${sendOnlyCount} send-only ${sendOnlyCount === 1 ? 'address' : 'addresses'}, manage in Settings`}
            className="flex min-h-8 items-center pr-2.5 pl-3 font-mono text-2xs text-paper-faint underline decoration-rule underline-offset-3 transition-colors hover:text-paper hover:decoration-paper"
          >
            +{sendOnlyCount} send-only
          </Link>
        )}
        <SectionLabel>Views</SectionLabel>
        <RailRow
          view="starred"
          mark={<StarIcon size={13} />}
          label={nameOfView('starred')}
          onNavigate={onNavigate}
        />
        <RailRow
          view="drafts"
          mark={<NotePencilIcon size={13} />}
          label={nameOfView('drafts')}
          onNavigate={onNavigate}
        />
        <RailRow
          view="sent"
          mark={<PaperPlaneTiltIcon size={13} />}
          label={nameOfView('sent')}
          onNavigate={onNavigate}
        />
        <RailRow
          view="archive"
          mark={<ArchiveIcon size={13} />}
          label={nameOfView('archive')}
          onNavigate={onNavigate}
        />
        <RailRow
          view="trash"
          mark={<TrashIcon size={13} />}
          label={nameOfView('trash')}
          onNavigate={onNavigate}
        />
        {/* Only where a server lists one: YOZZ never creates it. No count: spam asks nothing of you. */}
        {Object.values(junkFolders).includes(true) && (
          <RailRow
            view="junk"
            mark={<WarningOctagonIcon size={13} />}
            label={nameOfView('junk')}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {isDemo && <p className="label-rule px-3 pb-2">Demo data · dev only</p>}
      <div className="border-t border-rule-soft">
        <Link
          to="/settings"
          search={keepCompose}
          onClick={onNavigate}
          aria-current={isSettings ? 'page' : undefined}
          className={cn(
            'relative flex h-9 items-center gap-2.5 pr-2.5 pl-3 text-base transition-colors',
            isSettings
              ? 'bg-ink-hover text-paper'
              : 'text-paper-dim hover:bg-ink-hover/60 hover:text-paper',
          )}
        >
          {isSettings && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
          <span
            className={cn(
              'flex w-4 shrink-0 justify-center',
              isSettings ? 'text-paper' : 'text-paper-faint',
            )}
          >
            <GearIcon size={13} />
          </span>
          <span>Settings</span>
        </Link>
      </div>
    </nav>
  );
};
