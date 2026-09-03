import { cn } from '@fishballapps/cn';
import { CaretRightIcon, PlusIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { type AddressRecord, isInbound, markOf } from '../../addresses/record';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { buttonClass } from '../../ui/Button';
import { SendOnlyTag } from '../../ui/SendOnlyTag';

/** One row per address; what it does is a property of the row. */

const hostsOf = (record: AddressRecord): string =>
  isInbound(record) ? `${record.imap.host} · ${record.smtp.host}` : record.smtp.host;

/** Reading addresses first, in the rail's order, then the send-only ones. */
const byRole = (a: AddressRecord, b: AddressRecord): number =>
  Number(isInbound(b)) - Number(isInbound(a));

export const Addresses = () => {
  const { identities } = useMail();
  const sorted = [...identities].sort(byRole);

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-xl text-base leading-relaxed text-paper-dim">
          Every address you read from or send as. A reading address feeds the inbox and marks its
          mail with the letter shown; a send-only address only ever appears as a From.
        </p>
        <Link
          to="/connect"
          search={keepCompose}
          className={cn(buttonClass({ variant: 'primary' }), 'self-start sm:shrink-0')}
        >
          <PlusIcon size={13} weight="bold" />
          Add an address
        </Link>
      </div>

      {sorted.length === 0 ? (
        <div className="mt-6 border-y border-rule-soft py-10 text-center">
          <p className="text-base text-paper">No addresses yet.</p>
          <p className="mt-1 text-base text-paper-dim">
            Add one and it starts syncing as soon as it is stored.
          </p>
        </div>
      ) : (
        <ul className="mt-6 border-t border-rule">
          {sorted.map(record => (
            <li key={record.address}>
              <Link
                to="/settings/a/$address"
                params={{ address: record.address }}
                search={keepCompose}
                className="group grid grid-cols-[1.25rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 border-b border-rule-soft py-3 transition-colors hover:bg-ink-hover"
              >
                <span
                  aria-hidden
                  className="flex justify-center font-mono text-2xs text-paper-faint"
                >
                  {isInbound(record) ? markOf(record.address) : ''}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-base text-paper">{record.address}</span>
                  <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
                    {hostsOf(record)}
                  </span>
                </span>
                {isInbound(record) ? <span /> : <SendOnlyTag />}
                <CaretRightIcon
                  size={12}
                  className="text-paper-faint transition-colors group-hover:text-paper"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 border-y border-rule bg-ink-raised px-4 py-3.5">
        <p className="label-rule">Why send-only exists</p>
        <p className="mt-2 max-w-xl text-base leading-relaxed text-paper-dim">
          Google is removing “Send mail as” for third-party addresses in{' '}
          <span className="text-paper">January 2027</span>, after removing POP fetching and Gmailify
          in January 2026. If you send from a custom domain inside Gmail today, that stops working.
          Here it is the normal case: add the address with its SMTP details and it is in the From
          switch.
        </p>
      </div>
    </>
  );
};
