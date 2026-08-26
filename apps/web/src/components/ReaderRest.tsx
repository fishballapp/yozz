import { markOf } from '../lib/addresses';
import { unreadCount, useMail } from '../state/mail';
import { Wordmark } from './Wordmark';

/**
 * The reader at rest. On a wide screen this pane is roughly a third of the first viewport, and
 * "Select a message." wastes it — so it holds the product's own statement instead: what YOZZ is,
 * which addresses are feeding the stream, and an honest note of what is and is not fetched.
 */
export const ReaderRest = () => {
  const { accounts, threads } = useMail();

  return (
    <div className="flex h-full items-center justify-center bg-ink-sunken px-8">
      <div className="w-full max-w-sm">
        <Wordmark className="h-6 w-auto text-paper" />
        <p className="mt-3 text-base leading-relaxed text-paper-dim">
          One client over the mail you already own. Read every address in one stream, and answer as
          any address you control — over your own SMTP.
        </p>

        <p className="label-rule mt-8 border-b border-rule-soft pb-2">Reading</p>
        {accounts.length === 0 ? (
          <p className="mt-3 text-base leading-relaxed text-paper-faint">
            No address connected yet. Connect one and it appears here.
          </p>
        ) : (
          <ul className="mt-1">
            {accounts.map(account => {
              const unread = unreadCount(threads, account.address);
              return (
                <li
                  key={account.address}
                  className="flex items-center gap-3 border-b border-rule-soft py-2"
                >
                  <span className="flex w-4 shrink-0 justify-center font-mono text-2xs text-paper-faint">
                    {markOf(account.address)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-paper-dim">
                    {account.address}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-2xs ${unread > 0 ? 'text-signal' : 'text-paper-faint'}`}
                  >
                    {unread > 0 ? `${unread} unread` : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-6 font-mono text-2xs leading-relaxed text-paper-faint">
          Envelopes are fetched from each address's inbox when you unlock. Bodies are not yet.
        </p>
      </div>
    </div>
  );
};
