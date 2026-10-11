import { cn } from '@fishballapps/cn';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { type AddressRecord, isInbound } from '../../addresses/record';
import { keepCompose } from '../../compose/intent';
import { describeMailFailure } from '../../relay/describe-failure';
import { ServerRow } from '../../relay/ServerRow';
import { useMail } from '../../store/MailProvider';
import { Button, buttonClass } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { Definition, PageSection } from '../../ui/PageSection';
import { SendOnlyTag } from '../../ui/SendOnlyTag';
import { vaultErrorMessage } from '../../vault/screen-policy';
import { SettingsPane } from './SettingsPane';

/**
 * One address: its display name (saves itself), its servers (facts, edited in place and tested
 * again before they are stored, as Add an address tests them) and its removal.
 */
export const Address = () => {
  const { address } = useParams({ from: '/_app/settings/a/$address' });
  const { identities } = useMail();
  /** The store drops an address the moment the vault deletes it; the page holds it until it has left. */
  const [removing, setRemoving] = useState<AddressRecord>();
  const record = identities.find(candidate => candidate.address === address) ?? removing;

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

  // Keyed, so a form half-filled for one address is not carried to the next one picked.
  return <AddressPane key={record.address} record={record} onRemoving={setRemoving} />;
};

const AddressPane = ({
  record,
  onRemoving,
}: {
  record: AddressRecord;
  onRemoving: (record: AddressRecord | undefined) => void;
}) => (
  <SettingsPane
    title={
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate">{record.address}</span>
        {!isInbound(record) && <SendOnlyTag />}
      </span>
    }
    subline={isInbound(record) ? 'Reads and sends' : 'Sends only'}
  >
    <DisplayNameSection record={record} />
    <ServersSection record={record} />
    <RemoveSection record={record} onRemoving={onRemoving} />
  </SettingsPane>
);

type SavedState = 'idle' | 'shown' | 'fading';

/** A single text setting saves itself on blur and on Enter, and says so beside the field. */
const DisplayNameSection = ({ record }: { record: AddressRecord }) => {
  const { setSenderName, watchSession } = useMail();
  const stored = record.senderName ?? '';
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedState>('idle');
  useEffect(() => {
    if (saved === 'idle') return;
    const timer = setTimeout(
      () => setSaved(saved === 'shown' ? 'fading' : 'idle'),
      saved === 'shown' ? 2000 : 300,
    );
    return () => clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    if (draft.trim() === stored) return;
    // An action that outlives its session shows nothing in the next one.
    const isCurrent = watchSession();
    setError(null);
    try {
      await setSenderName(record.address, draft);
      if (isCurrent()) setSaved('shown');
    } catch (cause) {
      if (isCurrent()) setError(vaultErrorMessage(cause));
    }
  };

  const shown = draft.trim() === '' ? record.address : `${draft.trim()} <${record.address}>`;

  return (
    <PageSection id="address-display-name" label="Display name" error={error}>
      <form
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-3">
          <Input
            aria-labelledby="address-display-name"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => void save()}
            autoComplete="name"
            placeholder="Optional"
            className="max-w-xs"
          />
          <span
            aria-live="polite"
            className={cn(
              'text-2xs text-paper-faint transition-opacity duration-300',
              saved === 'shown' ? 'opacity-100' : 'opacity-0',
            )}
          >
            {saved === 'idle' ? '' : 'Saved'}
          </span>
        </div>
        <p className="mt-1.5 text-2xs text-paper-faint">{`Recipients see ${shown}.`}</p>
      </form>
    </PageSection>
  );
};

type Draft = {
  readonly imapHost: string;
  readonly imapPort: string;
  readonly imapUsername: string;
  readonly smtpHost: string;
  readonly smtpPort: string;
  readonly smtpUsername: string;
  /** Blank keeps the stored one. */
  readonly password: string;
};

const draftOf = (record: AddressRecord): Draft => ({
  imapHost: record.imap?.host ?? '',
  imapPort: String(record.imap?.port ?? ''),
  imapUsername: record.imap?.username ?? '',
  smtpHost: record.smtp.host,
  smtpPort: String(record.smtp.port),
  smtpUsername: record.smtp.username,
  password: '',
});

/** What stopped a save, and the server it belongs under; `form` is the vault's refusal. */
type Issue = { readonly server: 'imap' | 'smtp' | 'form'; readonly message: string };

const portOf = (text: string): number | null => {
  const port = Number(text.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};

/** The edited record, or the first thing wrong with the form. */
const recordFrom = (
  record: AddressRecord,
  draft: Draft,
): { readonly next: AddressRecord } | { readonly issue: Issue } => {
  const password = (stored: string) => (draft.password === '' ? stored : draft.password);
  const smtpPort = portOf(draft.smtpPort);
  const imapPort = portOf(draft.imapPort);
  if (record.imap !== undefined && (draft.imapHost.trim() === '' || imapPort === null)) {
    return {
      issue: { server: 'imap', message: 'Enter the IMAP host and a port from 1 to 65535.' },
    };
  }
  if (draft.smtpHost.trim() === '' || smtpPort === null) {
    return {
      issue: { server: 'smtp', message: 'Enter the SMTP host and a port from 1 to 65535.' },
    };
  }
  if (
    draft.smtpUsername.trim() === '' ||
    (record.imap !== undefined && draft.imapUsername.trim() === '')
  ) {
    return { issue: { server: 'form', message: 'Enter the username.' } };
  }
  return {
    next: {
      ...record,
      ...(record.imap === undefined || imapPort === null
        ? {}
        : {
            imap: {
              host: draft.imapHost.trim(),
              port: imapPort,
              username: draft.imapUsername.trim(),
              password: password(record.imap.password),
            },
          }),
      smtp: {
        host: draft.smtpHost.trim(),
        port: smtpPort,
        username: draft.smtpUsername.trim(),
        password: password(record.smtp.password),
      },
    },
  };
};

/** Facts, until Edit turns the section into the form that tests them again and stores them. */
const ServersSection = ({ record }: { record: AddressRecord }) => {
  const { replaceAddress, watchSession, isDemo } = useMail();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(record));
  /** What the save is doing now, as the Save button says it. */
  const [progress, setProgress] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const isBusy = progress !== null;
  // Edit goes away while the form is open; the keyboard comes back to it when the facts do.
  const editSlot = useRef<HTMLSpanElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !isEditing) editSlot.current?.querySelector('button')?.focus();
    wasEditing.current = isEditing;
  }, [isEditing]);
  const hasOneUsername = !isInbound(record) || record.imap.username === record.smtp.username;

  const edit = () => {
    setDraft(draftOf(record));
    setIssue(null);
    setIsEditing(true);
  };
  const cancel = () => {
    setIssue(null);
    setIsEditing(false);
  };
  const set = (key: keyof Draft) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft(current => ({ ...current, [key]: event.target.value }));

  const save = (event: FormEvent) => {
    event.preventDefault();
    // A lock during the tests ends the session this record was typed into; it is stored nowhere.
    const isCurrent = watchSession();
    void (async () => {
      setIssue(null);
      const built = recordFrom(record, draft);
      if ('issue' in built) {
        setIssue(built.issue);
        return;
      }
      const { next } = built;
      if (JSON.stringify(next) === JSON.stringify(record)) {
        setIsEditing(false);
        return;
      }
      try {
        if (!isDemo) {
          // Both tried before anything is stored. The TLS stack loads on demand.
          if (isInbound(next)) {
            setProgress(`Testing ${next.imap.host}…`);
            const { testImap } = await import('../../threads/sync');
            if (!isCurrent()) return;
            const test = await testImap(next.imap);
            if (!isCurrent()) return;
            if (!test.ok) {
              setIssue({
                server: 'imap',
                message: describeMailFailure(test.error, next.imap.host),
              });
              return;
            }
          }
          setProgress(`Testing ${next.smtp.host}…`);
          const { testSmtp } = await import('../../compose/send');
          if (!isCurrent()) return;
          const test = await testSmtp(next.smtp);
          if (!isCurrent()) return;
          if (!test.ok) {
            setIssue({ server: 'smtp', message: describeMailFailure(test.error, next.smtp.host) });
            return;
          }
        }
        setProgress('Saving…');
        await replaceAddress(next);
        if (isCurrent()) setIsEditing(false);
      } catch (cause) {
        if (isCurrent()) setIssue({ server: 'form', message: vaultErrorMessage(cause) });
      } finally {
        if (isCurrent()) setProgress(null);
      }
    })();
  };

  return (
    <PageSection
      label="Servers"
      note={
        isInbound(record)
          ? 'Mail is read from the IMAP server and sent through the SMTP server.'
          : 'Mail is sent through the SMTP server. Nothing is read from this address.'
      }
      action={
        // The heading rule keeps its height while the form is open, so nothing below it moves.
        <span ref={editSlot} className="flex">
          {isEditing ? (
            <span aria-hidden className="h-7" />
          ) : (
            <Button variant="ghost" size="sm" onClick={edit} aria-label="Edit servers">
              Edit
            </Button>
          )}
        </span>
      }
      error={isEditing && issue?.server === 'form' ? issue.message : null}
    >
      {isEditing ? (
        <form onSubmit={save} className="max-w-xl">
          {/* Disabled while the tests run, so nothing typed meanwhile is dropped from the record being tested. */}
          <fieldset disabled={isBusy} className="min-w-0 space-y-5">
            {isInbound(record) && (
              <ServerFields
                protocol="IMAP"
                host={draft.imapHost}
                port={draft.imapPort}
                onHost={set('imapHost')}
                onPort={set('imapPort')}
                error={issue?.server === 'imap' ? issue.message : null}
                autoFocus
              />
            )}
            <ServerFields
              protocol="SMTP"
              host={draft.smtpHost}
              port={draft.smtpPort}
              onHost={set('smtpHost')}
              onPort={set('smtpPort')}
              error={issue?.server === 'smtp' ? issue.message : null}
              autoFocus={!isInbound(record)}
            />
            {hasOneUsername ? (
              <FieldRow label="Username" htmlFor="address-username">
                <Input
                  id="address-username"
                  required
                  autoComplete="username"
                  value={draft.smtpUsername}
                  onChange={event => {
                    const { value } = event.target;
                    setDraft(current => ({ ...current, imapUsername: value, smtpUsername: value }));
                  }}
                  className="font-mono"
                />
              </FieldRow>
            ) : (
              <>
                <FieldRow label="IMAP username" htmlFor="address-imap-username">
                  <Input
                    id="address-imap-username"
                    required
                    autoComplete="username"
                    value={draft.imapUsername}
                    onChange={set('imapUsername')}
                    className="font-mono"
                  />
                </FieldRow>
                <FieldRow label="SMTP username" htmlFor="address-smtp-username">
                  <Input
                    id="address-smtp-username"
                    required
                    value={draft.smtpUsername}
                    onChange={set('smtpUsername')}
                    className="font-mono"
                  />
                </FieldRow>
              </>
            )}
            <FieldRow label="Password" htmlFor="address-password">
              <Input
                id="address-password"
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank to keep the stored one"
                value={draft.password}
                onChange={set('password')}
              />
            </FieldRow>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" disabled={isBusy}>
                {progress ?? 'Save'}
              </Button>
              <Button variant="ghost" disabled={isBusy} onClick={cancel}>
                Cancel
              </Button>
            </div>
          </fieldset>
        </form>
      ) : (
        <dl>
          {isInbound(record) && (
            <ServerRow term="IMAP" host={record.imap.host} port={record.imap.port} />
          )}
          <ServerRow term="SMTP" host={record.smtp.host} port={record.smtp.port} />
          {hasOneUsername ? (
            <Definition term="Username">{record.smtp.username}</Definition>
          ) : (
            <>
              <Definition term="IMAP user">{record.imap?.username}</Definition>
              <Definition term="SMTP user">{record.smtp.username}</Definition>
            </>
          )}
        </dl>
      )}
    </PageSection>
  );
};

/** Host and port as one ruled line, with what went wrong with this server under it. */
const ServerFields = ({
  protocol,
  host,
  port,
  onHost,
  onPort,
  error,
  autoFocus,
}: {
  protocol: 'IMAP' | 'SMTP';
  host: string;
  port: string;
  onHost: (event: ChangeEvent<HTMLInputElement>) => void;
  onPort: (event: ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  autoFocus?: boolean;
}) => {
  const id = `address-${protocol.toLowerCase()}`;
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
        <FieldRow label={`${protocol} host`} htmlFor={`${id}-host`}>
          <Input
            id={`${id}-host`}
            required
            autoFocus={autoFocus}
            value={host}
            onChange={onHost}
            className="font-mono"
          />
        </FieldRow>
        <FieldRow label="Port" htmlFor={`${id}-port`}>
          <Input
            id={`${id}-port`}
            required
            inputMode="numeric"
            value={port}
            onChange={onPort}
            className="font-mono"
          />
        </FieldRow>
      </div>
      {error !== null && (
        <p role="alert" className="mt-1.5 text-base text-danger">
          {error}
        </p>
      )}
    </div>
  );
};

const RemoveSection = ({
  record,
  onRemoving,
}: {
  record: AddressRecord;
  onRemoving: (record: AddressRecord | undefined) => void;
}) => {
  const navigate = useNavigate();
  const { removeAddress, watchSession } = useMail();
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    // An action that outlives its session shows nothing and goes nowhere in the next one.
    const isCurrent = watchSession();
    setError(null);
    onRemoving(record);
    try {
      await removeAddress(record.address);
    } catch (cause) {
      onRemoving(undefined);
      if (isCurrent()) setError(vaultErrorMessage(cause));
      return;
    }
    if (!isCurrent()) return;
    await navigate({ to: '/settings', search: previous => previous });
  };

  return (
    <PageSection
      label="Remove"
      note={
        isInbound(record)
          ? 'Its mail leaves the inbox and the copy cached on this device is cleared. The mailbox itself is untouched.'
          : 'It leaves the From switch. Nothing at the provider changes.'
      }
      error={error}
    >
      <ConfirmDialog
        trigger={<Button variant="danger" className="-ml-3" />}
        triggerLabel="Remove address"
        title={`Remove ${record.address}?`}
        description="Its stored password is deleted from the vault. Adding it back takes a minute and a password from the provider; nothing else changes."
        confirmLabel="Remove address"
        busyLabel="Removing…"
        onConfirm={remove}
      />
    </PageSection>
  );
};
