import { cn } from '@fishballapps/cn';
import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { isInbound } from '../../addresses/record';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { Button, buttonClass } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { Definition, PageSection } from '../../ui/PageColumn';
import { SendOnlyTag } from '../../ui/SendOnlyTag';
import { vaultErrorMessage } from '../../vault/screen-policy';

/**
 * One address: where its servers are, and the one destructive act. Servers and
 * the password are read-only on purpose — the record is re-tested end to end when it is added, and
 * an edit that skipped that would store a server nobody has proven reachable.
 */
export const Address = () => {
  const { address } = useParams({ from: '/_app/settings/a/$address' });
  const navigate = useNavigate();
  const { identities, removeAddress, setSenderName } = useMail();
  const record = identities.find(candidate => candidate.address === address);

  const [error, setError] = useState<string | null>(null);
  const storedSenderName = record?.senderName ?? '';
  const [senderName, setSenderNameDraft] = useState(storedSenderName);
  useEffect(() => {
    setSenderNameDraft(storedSenderName);
  }, [storedSenderName]);

  if (record === undefined) {
    return (
      <div className="py-10 text-center">
        <p className="text-base text-paper">Not one of your addresses</p>
        <p className="mt-1 text-base text-paper-dim">Nothing is stored at {address}.</p>
        <Link
          to="/settings"
          search={keepCompose}
          className={cn(buttonClass({ variant: 'secondary' }), 'mt-5')}
        >
          Back to addresses
        </Link>
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(vaultErrorMessage(err));
    }
  };

  const sameUsername = !isInbound(record) || record.imap.username === record.smtp.username;

  return (
    <>
      <Link
        to="/settings"
        search={keepCompose}
        className={cn(buttonClass({ variant: 'ghost', size: 'sm' }), '-ml-2.5')}
      >
        <CaretLeftIcon size={12} />
        Addresses
      </Link>

      <div className="mt-4 mb-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="min-w-0 truncate text-[17px] leading-snug font-medium tracking-[-0.01em] text-paper">
            {record.address}
          </h2>
          {!isInbound(record) && <SendOnlyTag />}
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mb-6 text-base text-danger">
          {error}
        </p>
      )}

      <PageSection
        label="Display name"
        note={`How recipients see mail from this address: ${senderName.trim() === '' ? record.address : `${senderName.trim()} <${record.address}>`}. It goes in the From header and nowhere else; inside YOZZ the address is always shown as itself.`}
      >
        <FieldRow label="Display name" htmlFor="address-sender-name">
          <Input
            id="address-sender-name"
            value={senderName}
            onChange={event => setSenderNameDraft(event.target.value)}
            onBlur={() => {
              if (senderName.trim() === storedSenderName) return;
              void run(() => setSenderName(record.address, senderName));
            }}
            autoComplete="name"
            placeholder="Optional"
            className="max-w-xs"
          />
        </FieldRow>
      </PageSection>

      <PageSection
        label="Servers"
        note={
          isInbound(record)
            ? 'Read over IMAP, sent over SMTP, both on implicit TLS through the relay.'
            : 'Send-only: nothing is read from this address. Mail goes out over its SMTP server.'
        }
      >
        <dl>
          {isInbound(record) && (
            <Definition term="IMAP">
              {record.imap.host}:{record.imap.port}
            </Definition>
          )}
          <Definition term="SMTP">
            {record.smtp.host}:{record.smtp.port}
          </Definition>
          {sameUsername ? (
            <Definition term="Username">{record.smtp.username}</Definition>
          ) : (
            <>
              <Definition term="IMAP user">{record.imap.username}</Definition>
              <Definition term="SMTP user">{record.smtp.username}</Definition>
            </>
          )}
        </dl>
        <p className="mt-3 text-2xs text-paper-faint">
          To change a server or the password, remove the address and add it again. Nothing at the
          provider changes.
        </p>
      </PageSection>

      <PageSection
        label="Remove"
        note={
          isInbound(record)
            ? 'Its mail leaves the inbox and the copy cached on this device is cleared. The mailbox itself is untouched.'
            : 'It leaves the From switch. Nothing at the provider changes.'
        }
      >
        <ConfirmDialog
          trigger={<Button variant="danger" />}
          triggerLabel="Remove address"
          title={`Remove ${record.address}?`}
          description="Its stored password is deleted from the vault. Adding it back takes a minute and a password from the provider; nothing else changes."
          confirmLabel="Remove address"
          busyLabel="Removing…"
          onConfirm={() =>
            run(async () => {
              await removeAddress(record.address);
              await navigate({ to: '/settings', search: previous => previous });
            })
          }
        />
      </PageSection>
    </>
  );
};
