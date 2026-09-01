import type { InboundAddress } from '../lib/addresses';
import { clockTime } from '../lib/time';
import { type MailConnectionFailure, useMail } from '../state/mail';

const shortFailureReason = (failure: MailConnectionFailure): string => {
  switch (failure.kind) {
    case 'relay':
      return 'relay unreachable';
    case 'error':
      return 'error';
    case 'tls':
      return 'TLS failed';
    case 'pin-mismatch':
      return 'server key changed';
    case 'auth':
      return 'auth rejected';
    case 'imap':
      return failure.reason.kind === 'no' ? 'IMAP rejected' : `IMAP ${failure.reason.kind}`;
    case 'smtp':
      return `SMTP ${failure.reason.kind}`;
  }
};

/** One line across the foot: where you are and how much is there. Counts are optional; Settings is not a mailbox. */
export const StatusBar = ({
  title,
  counts,
}: {
  title: string;
  counts?: { unread: number; total: number };
}) => {
  const {
    accounts,
    identities,
    isDemo: demo,
    syncStates,
    liveStates,
    flagError,
    sentCopyError,
    sync,
  } = useMail();

  const isSyncing = accounts.some(account => syncStates[account.address]?.status === 'syncing');
  const failedAccount = accounts.find(account => syncStates[account.address]?.status === 'failed');
  const syncedAccounts = accounts.filter(
    (account): account is InboundAddress => syncStates[account.address]?.status === 'synced',
  );

  // `live` while any account has one (`live↺` when every live one resumed), else reconnecting, else `offline` only when a server or the network ended one.
  const connectionWord = (() => {
    if (demo || accounts.length === 0) return null;
    const states = accounts.flatMap(account => liveStates[account.address] ?? []);
    const live = states.flatMap(state => (state.status === 'live' ? [state] : []));
    if (live.length > 0) return live.every(state => state.resumed) ? 'live↺' : 'live';
    if (states.some(state => state.status === 'reconnecting')) return 'reconnecting…';
    if (states.some(state => state.status === 'failed') && !isSyncing) return 'offline';
    return null;
  })();

  let statusText: string;
  if (demo) {
    statusText = 'Demo data · dev only';
  } else if (accounts.length === 0) {
    const count = identities.length;
    statusText = `${count} ${count === 1 ? 'address' : 'addresses'} · nothing to sync`;
  } else if (isSyncing) {
    statusText = 'syncing…';
  } else if (failedAccount !== undefined) {
    const syncState = syncStates[failedAccount.address];
    const failureReason =
      syncState?.status === 'failed' ? shortFailureReason(syncState.failure) : 'error';
    statusText = `sync failed · ${failureReason}`;
  } else if (sentCopyError !== null) {
    statusText = sentCopyError;
  } else if (flagError !== null) {
    statusText = 'flag not saved';
  } else if (syncedAccounts.length > 0) {
    const newestAt = Math.max(
      ...syncedAccounts.map(account => {
        const s = syncStates[account.address];
        return s?.status === 'synced' ? s.at : 0;
      }),
    );
    statusText = `synced ${clockTime(newestAt)}`;
  } else {
    statusText = 'no sync yet';
  }

  if (connectionWord !== null) statusText = `${connectionWord} · ${statusText}`;

  const canSync = !demo && accounts.length > 0 && !isSyncing;

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
      {canSync ? (
        <button
          type="button"
          onClick={() => void sync()}
          className="shrink-0 truncate tracking-[0.08em] uppercase transition-colors hover:text-paper"
          title={flagError ?? 'Sync now'}
        >
          {statusText}
        </button>
      ) : (
        <p className="shrink-0 truncate tracking-[0.08em] uppercase">{statusText}</p>
      )}
    </footer>
  );
};
