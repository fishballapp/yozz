import { Select } from '@base-ui/react/select';
import { CaretUpDownIcon, CheckIcon } from '@phosphor-icons/react';
import { type AddressRecord, isInbound } from '@yozz.app/mail/addresses/record';
import { cn } from 'cn';
import { useMail } from '../store/MailProvider';
import { SendOnlyTag } from '../ui/SendOnlyTag';

/**
 * The first and largest control in the composer; it always states the SMTP host it will use (which
 * tells the person which provider sends; the port is Settings' to show), and a send-only address is
 * labelled, not hidden.
 */

const smtpVia = (identity: AddressRecord) => identity.smtp.host;

const IdentityOption = ({ identity }: { identity: AddressRecord }) => (
  <>
    <span className="flex w-4 shrink-0 justify-center text-signal">
      <Select.ItemIndicator>
        <CheckIcon size={12} weight="bold" />
      </Select.ItemIndicator>
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <Select.ItemText className="truncate text-base text-paper">
          {identity.address}
        </Select.ItemText>
        {!isInbound(identity) && <SendOnlyTag />}
      </span>
      <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
        {identity.senderName !== undefined && `${identity.senderName} · `}via {smtpVia(identity)}
      </span>
    </span>
  </>
);

export const FromSwitch = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (identityId: string) => void;
}) => {
  const { identities } = useMail();
  const selected = identities.find(identity => identity.address === value) ?? identities[0];
  const withInbox = identities.filter(isInbound);
  const sendOnly = identities.filter(identity => !isInbound(identity));

  if (selected === undefined) {
    return (
      <div className="flex items-stretch">
        <span className="label-rule flex w-20 shrink-0 items-center pl-4">From</span>
        <button
          type="button"
          disabled
          className="flex min-w-0 flex-1 items-center border-b border-rule bg-ink-sunken py-2 pr-2.5 pl-3 text-left text-base text-paper-faint"
        >
          No address to send from
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-stretch">
      <span className="label-rule flex w-20 shrink-0 items-center pl-4">From</span>
      <Select.Root value={value} onValueChange={next => onChange(String(next))}>
        <Select.Trigger
          className={cn(
            'group relative flex min-w-0 flex-1 items-center gap-2 border-b border-rule bg-ink-sunken py-2 pr-2.5 pl-3 text-left outline-none transition-colors',
            'hover:border-paper-faint data-[popup-open]:border-signal',
          )}
        >
          {/* The identity channel is marked in signal so the composer's loudest edge is the
              address it will send from. */}
          <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-base text-paper">{selected.address}</span>
              {!isInbound(selected) && <SendOnlyTag />}
            </span>
            <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
              {selected.senderName !== undefined && `${selected.senderName} · `}via{' '}
              {smtpVia(selected)}
            </span>
          </span>
          <Select.Icon className="shrink-0 text-paper-faint group-hover:text-paper">
            <CaretUpDownIcon size={13} />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          {/* On the field's own left edge, flush to the screen's on a phone as the field is; as
              tall as the screen allows, so a short list never ends mid-row. */}
          <Select.Positioner
            sideOffset={2}
            align="start"
            collisionPadding={{ top: 8, bottom: 8, left: 0, right: 0 }}
            alignItemWithTrigger={false}
            className="z-50"
          >
            <Select.Popup className="max-h-[min(28rem,var(--available-height))] w-[var(--anchor-width)] min-w-72 overflow-y-auto border border-rule bg-ink-raised pt-1 pb-1.5 outline-none">
              <Select.Group>
                <Select.GroupLabel className="label-rule block px-2.5 pt-2 pb-1">
                  Addresses
                </Select.GroupLabel>
                {withInbox.map(identity => (
                  <Select.Item
                    key={identity.address}
                    value={identity.address}
                    className="flex cursor-default items-start gap-1 px-2.5 py-1.5 outline-none data-[highlighted]:bg-ink-hover"
                  >
                    <IdentityOption identity={identity} />
                  </Select.Item>
                ))}
              </Select.Group>

              {sendOnly.length > 0 && (
                <Select.Group>
                  <Select.GroupLabel className="label-rule mt-1 block border-t border-rule-soft px-2.5 pt-2.5 pb-1">
                    Send-only
                  </Select.GroupLabel>
                  {sendOnly.map(identity => (
                    <Select.Item
                      key={identity.address}
                      value={identity.address}
                      className="flex cursor-default items-start gap-1 px-2.5 py-1.5 outline-none data-[highlighted]:bg-ink-hover"
                    >
                      <IdentityOption identity={identity} />
                    </Select.Item>
                  ))}
                </Select.Group>
              )}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
};
