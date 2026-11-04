import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { useMail } from '../store/MailProvider';

/**
 * One line across the foot: where you are and how much is there. Counts are optional; Settings is
 * not a mailbox. Its right end is empty while all is well — that work is going on is the activity
 * bar's to say — and otherwise names what went wrong.
 */
export const StatusBar = ({
  title,
  counts,
}: {
  title: string;
  counts?: { unread: number; total: number };
}) => {
  const { mailboxes, isDemo: demo, syncStates, mailError, sentCopyError, sync } = useMail();

  const failedMailbox = mailboxes.find(mailbox => syncStates[mailbox.address]?.status === 'failed');
  const failedSync = (() => {
    if (failedMailbox === undefined) return null;
    const state = syncStates[failedMailbox.address];
    if (state?.status !== 'failed') return null;
    return describeMailFailure(state.failure, failedMailbox.imap.host);
  })();

  const notice = (() => {
    if (demo) return 'Demo data · dev only';
    return failedSync ?? sentCopyError ?? mailError;
  })();

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-rule-soft bg-ink-raised px-3 font-mono text-2xs text-paper-faint">
      <p className="truncate">
        <span className="text-paper-dim">{title}</span>
        {counts !== undefined && (
          <>
            <span> · </span>
            <span className={counts.unread > 0 ? 'text-signal' : undefined}>
              {counts.unread} unread
            </span>
            <span> · </span>
            <span>
              {counts.total} {counts.total === 1 ? 'message' : 'messages'}
            </span>
          </>
        )}
      </p>
      {notice !== null && (
        <p className="flex min-w-0 items-center gap-1.5 tracking-[0.08em] uppercase">
          <span className="truncate" title={notice}>
            {notice}
          </span>
          {!demo && failedSync !== null && failedMailbox !== undefined && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => void sync(failedMailbox.address)}
                className="shrink-0 text-paper underline underline-offset-3 transition-colors hover:text-signal"
              >
                Retry
              </button>
            </>
          )}
        </p>
      )}
    </footer>
  );
};
