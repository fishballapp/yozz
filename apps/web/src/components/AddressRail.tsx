import { cn } from '@fishballapps/cn';
import {
  ArchiveIcon,
  GearIcon,
  MailboxIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { markOf } from '../lib/addresses';
import { keepCompose, withCompose } from '../lib/compose';
import { type MailboxId, unreadCount, useMail } from '../state/mail';
import { buttonClass } from './ui/Button';
import { Wordmark } from './Wordmark';

/**
 * Address-first (PRODUCT.md principle 2); connecting an account lives in Settings. The Inbox row
 * is labelled "Inbox" while its id stays `unified` (DECISIONS.md). Every link uses `keepCompose`.
 */

const UnifiedRow = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { threads } = useMail();
  const params = useParams({ strict: false });
  const isActive = params.mailbox === 'unified';
  const unread = unreadCount(threads, 'unified');

  return (
    <Link
      to="/m/$mailbox"
      params={{ mailbox: 'unified' }}
      search={keepCompose}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative mx-2 mb-1 flex h-11 items-center gap-2.5 px-2.5 transition-colors',
        isActive ? 'bg-ink-hover text-paper' : 'text-paper-dim hover:bg-ink-hover/60',
      )}
    >
      {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      <MailboxIcon size={16} className={isActive ? 'text-paper' : 'text-paper-faint'} />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium tracking-[-0.01em]">
        Inbox
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
  mailbox,
  mark,
  label,
  count,
  onNavigate,
}: {
  mailbox: MailboxId;
  mark: ReactNode;
  label: string;
  count?: number;
  onNavigate?: () => void;
}) => {
  const params = useParams({ strict: false });
  const isActive = params.mailbox === mailbox;

  return (
    <Link
      to="/m/$mailbox"
      params={{ mailbox }}
      search={keepCompose}
      onClick={onNavigate}
      // Explicit rather than inherited from TanStack Router's own `aria-current`.
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2.5 py-1.5 pr-2.5 pl-3 text-base transition-colors',
        isActive ? 'bg-ink-hover text-paper' : 'text-paper-dim hover:bg-ink-hover/60',
      )}
    >
      {/* One signal hit per active row: the edge bar. The mark stays neutral — spending the
          accent on bar + mark + count at once is how an accent stops meaning anything. */}
      {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />}
      {/* The mark is a visual key to the list gutter, not a word: screen readers would otherwise
          announce this row as "J jason at jyu dot example 2". */}
      <span
        aria-hidden
        className={cn(
          'flex w-4 shrink-0 justify-center font-mono text-2xs',
          isActive ? 'text-paper' : 'text-paper-faint',
        )}
      >
        {mark}
      </span>
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
  const { accounts, threads } = useMail();

  return (
    <nav className="flex h-full flex-col bg-ink-raised" aria-label="Mailboxes">
      <div className="px-3 pt-4 pb-3">
        <Link
          to="/m/$mailbox"
          params={{ mailbox: 'unified' }}
          search={keepCompose}
          onClick={onNavigate}
          className="inline-flex text-paper"
        >
          <Wordmark className="h-3.5 w-auto" />
        </Link>
      </div>

      <div className="px-3 pb-3">
        <Link
          to="."
          search={withCompose('new')}
          // The mobile sheet is a modal; left open behind the composer it traps focus.
          onClick={onNavigate}
          className={cn(buttonClass({ variant: 'primary' }), 'w-full justify-start gap-2')}
        >
          <PlusIcon size={14} weight="bold" />
          Compose
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <UnifiedRow onNavigate={onNavigate} />

        <SectionLabel>Addresses</SectionLabel>
        {accounts.map(account => (
          <RailRow
            key={account.address}
            mailbox={account.address}
            mark={markOf(account.address)}
            label={account.address}
            count={unreadCount(threads, account.address)}
            onNavigate={onNavigate}
          />
        ))}
        <SectionLabel>Views</SectionLabel>
        <RailRow
          mailbox="starred"
          mark={<StarIcon size={13} />}
          label="Starred"
          onNavigate={onNavigate}
        />
        <RailRow
          mailbox="drafts"
          mark={<NotePencilIcon size={13} />}
          label="Drafts"
          onNavigate={onNavigate}
        />
        <RailRow
          mailbox="sent"
          mark={<PaperPlaneTiltIcon size={13} />}
          label="Sent"
          onNavigate={onNavigate}
        />
        <RailRow
          mailbox="archive"
          mark={<ArchiveIcon size={13} />}
          label="Archive"
          onNavigate={onNavigate}
        />
        <RailRow
          mailbox="trash"
          mark={<TrashIcon size={13} />}
          label="Trash"
          onNavigate={onNavigate}
        />
      </div>

      <div className="border-t border-rule-soft">
        <Link
          to="/settings"
          search={keepCompose}
          onClick={onNavigate}
          className="flex h-9 items-center gap-2.5 pr-2.5 pl-3 text-base text-paper-dim transition-colors hover:bg-ink-hover/60 hover:text-paper"
        >
          <span className="flex w-4 shrink-0 justify-center">
            <GearIcon size={13} />
          </span>
          <span>Settings</span>
        </Link>
      </div>
    </nav>
  );
};
