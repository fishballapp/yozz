import { useNavigate } from '@tanstack/react-router';
import type { MailAutoconfig } from '@yozz.app/vault-contract';
import { type FormEvent, useRef, useState } from 'react';
import { ZodError } from 'zod';
import {
  type AutoconfigLookup,
  describeSource,
  domainOf,
  lookupMailServers,
  usernameFor,
} from '../addresses/autoconfig';
import { type AddressRecord, addressRecordSchema, isInbound } from '../addresses/record';
import { describeMailFailure } from '../relay/describe-failure';
import { useMail } from '../store/MailProvider';
import { agentLabel } from '../ui/agent-label';
import { Button } from '../ui/Button';
import { FieldRow, Input } from '../ui/Field';
import { Definition, PageColumn } from '../ui/PageColumn';
import { vaultErrorMessage } from '../vault/screen-policy';

/**
 * The domain is looked up the way Thunderbird looks it up (autoconfig, ISPDB, the MX host's
 * entry, SRV) and shown as facts to confirm; a domain that publishes nothing gets the fields.
 * The password is tried against each server before the record is written.
 */

type Lookup =
  | { readonly state: 'idle' }
  | { readonly state: 'looking'; readonly domain: string }
  | { readonly state: 'done'; readonly domain: string; readonly result: AutoconfigLookup };

type Servers = {
  readonly imapHost: string;
  readonly imapPort: string;
  readonly smtpHost: string;
  readonly smtpPort: string;
};

const BLANK_SERVERS: Servers = { imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465' };

type Resolved = { readonly result: AutoconfigLookup; readonly servers: Servers };

/** The found servers, unless the person is editing them by hand. */
const serversWith = (config: MailAutoconfig | null, isEditing: boolean, typed: Servers): Servers =>
  config === null || isEditing
    ? typed
    : {
        imapHost: config.imap?.host ?? typed.imapHost,
        imapPort: config.imap === null ? typed.imapPort : String(config.imap.port),
        smtpHost: config.smtp?.host ?? typed.smtpHost,
        smtpPort: config.smtp === null ? typed.smtpPort : String(config.smtp.port),
      };

export const Connect = () => {
  const navigate = useNavigate();
  const { identities, putAddress, isDemo: demo } = useMail();

  const [address, setAddress] = useState('');
  const [senderName, setSenderName] = useState('');
  const [isSendOnly, setIsSendOnly] = useState(false);
  const [servers, setServers] = useState<Servers>(BLANK_SERVERS);
  const [username, setUsername] = useState('');
  // A ref as well: a lookup landing after the person started editing must not overwrite them.
  const [isUsernameEdited, setIsUsernameEdited] = useState(false);
  const usernameEdited = useRef(false);
  const [password, setPassword] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [isEditingServers, setIsEditingServers] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest lookup may land, and a submit mid-flight waits for it.
  const lookupSeq = useRef(0);
  const inFlight = useRef<{ domain: string; done: Promise<Resolved> } | null>(null);

  const found =
    lookup.state === 'done' && lookup.result.status === 'found' ? lookup.result.config : null;

  const lookUp = (domain: string, forAddress: string): Promise<Resolved> => {
    lookupSeq.current += 1;
    const seq = lookupSeq.current;
    setLookup({ state: 'looking', domain });
    // Servers typed for another domain are not this domain's.
    setServers(BLANK_SERVERS);
    setIsEditingServers(false);
    // Holds a promise exactly while one is in flight; a lookup that resolves without yielding (demo) must not leave a stale one.
    const done = Promise.resolve().then(async (): Promise<Resolved> => {
      try {
        const result: AutoconfigLookup = demo
          ? { status: 'unavailable' }
          : await lookupMailServers(domain);
        const config = result.status === 'found' ? result.config : null;
        const resolved = { result, servers: serversWith(config, false, BLANK_SERVERS) };
        if (seq !== lookupSeq.current) return resolved;
        setLookup({ state: 'done', domain, result });
        setServers(resolved.servers);
        if (config !== null && !usernameEdited.current) {
          setUsername(usernameFor(forAddress, config.username));
        }
        setIsEditingServers(config === null);
        return resolved;
      } finally {
        if (seq === lookupSeq.current) inFlight.current = null;
      }
    });
    inFlight.current = { domain, done };
    return done;
  };

  const onAddressSettled = () => {
    const domain = domainOf(address);
    if (domain === null) return;
    if (lookup.state === 'idle' || lookup.domain !== domain) {
      void lookUp(domain, address);
    } else if (found !== null && !isUsernameEdited) {
      setUsername(usernameFor(address, found.username));
    }
  };

  const needsImap = !isSendOnly;
  const isComplete = found !== null && found.smtp !== null && (!needsImap || found.imap !== null);
  const showFields = lookup.state === 'done' && (isEditingServers || !isComplete);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void (async () => {
      setIsBusy(true);
      setError(null);
      try {
        const trimmed = address.trim();
        // The address is the natural key, so a second record would replace the first.
        if (identities.some(existing => existing.address === trimmed)) {
          setError('That address is already stored. Open it from Settings.');
          return;
        }
        const domain = domainOf(trimmed);
        if (domain === null) {
          setError('Enter a full email address.');
          return;
        }
        // Submitting straight from the address field: wait for this domain's lookup, or start one.
        const pending = inFlight.current;
        const awaited =
          pending !== null && pending.domain === domain
            ? await pending.done
            : lookup.state === 'idle' || lookup.domain !== domain
              ? await lookUp(domain, trimmed)
              : null;
        const use =
          awaited === null ? serversWith(found, isEditingServers, servers) : awaited.servers;
        if (use.smtpHost.trim() === '' || (needsImap && use.imapHost.trim() === '')) {
          setIsEditingServers(true);
          setError('Enter the mail servers, then try again.');
          return;
        }
        // A lookup just waited for has not re-rendered yet.
        const awaitedConfig =
          awaited !== null && awaited.result.status === 'found' ? awaited.result.config : null;
        const login =
          awaitedConfig !== null && !usernameEdited.current
            ? usernameFor(trimmed, awaitedConfig.username)
            : (username.trim() === '' ? trimmed : username).trim();
        const record: AddressRecord = addressRecordSchema.parse({
          address: trimmed,
          ...(senderName.trim() === '' ? {} : { senderName: senderName.trim() }),
          smtp: {
            host: use.smtpHost.trim(),
            port: Number(use.smtpPort),
            username: login,
            password,
          },
          ...(isSendOnly
            ? {}
            : {
                imap: {
                  host: use.imapHost.trim(),
                  port: Number(use.imapPort),
                  username: login,
                  password,
                },
              }),
        });
        if (!demo) {
          // Both tried before anything is stored. The TLS stack loads on demand.
          if (isInbound(record)) {
            const { testImap } = await import('../threads/sync');
            const test = await testImap(record.imap);
            if (!test.ok) {
              setError(describeMailFailure(test.error, record.imap.host));
              return;
            }
          }
          const { testSmtp } = await import('../compose/send');
          const test = await testSmtp(record.smtp);
          if (!test.ok) {
            setError(describeMailFailure(test.error, record.smtp.host));
            return;
          }
        }
        await putAddress(record);
        if (isInbound(record)) {
          void navigate({
            to: '/m/$mailbox',
            params: { mailbox: record.address },
            search: previous => previous,
          });
        } else {
          void navigate({ to: '/settings', search: previous => previous });
        }
      } catch (err) {
        if (err instanceof ZodError) {
          const first = err.issues[0];
          setError(first === undefined ? 'That form is not valid.' : first.message);
        } else {
          setError(vaultErrorMessage(err));
        }
      } finally {
        setIsBusy(false);
      }
    })();
  };

  const lookupNote = (() => {
    switch (lookup.state) {
      case 'idle':
        return 'Looked up from the address as soon as you enter it.';
      case 'looking':
        return `Looking up mail servers for ${lookup.domain}…`;
      case 'done':
        switch (lookup.result.status) {
          case 'found':
            return isComplete
              ? `From ${describeSource(lookup.result.config)}.`
              : `${describeSource(lookup.result.config)} names only one server. Enter the other one.`;
          case 'none':
            return `${lookup.domain} publishes no mail configuration. Enter its servers by hand.`;
          case 'unavailable':
            return demo
              ? 'No lookup in demo mode. Enter the servers by hand.'
              : `Could not look up ${lookup.domain}. Enter its servers by hand.`;
        }
    }
  })();

  const setServer = (key: keyof Servers) => (value: string) =>
    setServers(current => ({ ...current, [key]: value }));

  return (
    <PageColumn
      title="Add an address"
      description="A reading address joins the inbox as its own view; a send-only address only ever appears as a From. The password is tried against each server first, then encrypted with a key only your devices hold."
    >
      <form onSubmit={submit} className="max-w-xl space-y-6">
        <FieldRow label="Email address" htmlFor="connect-address">
          <Input
            id="connect-address"
            aria-label={agentLabel('Email address', address)}
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={address}
            onChange={event => {
              const next = event.target.value;
              setAddress(next);
              if (!isUsernameEdited) setUsername(next);
            }}
            onBlur={onAddressSettled}
            placeholder="you@yourdomain.com"
          />
        </FieldRow>

        <FieldRow
          label="Display name"
          htmlFor="connect-sender-name"
          hint={`Optional. How recipients see mail from this address: ${senderName.trim() === '' ? 'Jason Yu' : senderName.trim()} <${address.trim() === '' ? 'you@yourdomain.com' : address.trim()}>. Inside YOZZ the address is always shown as itself.`}
        >
          <Input
            id="connect-sender-name"
            value={senderName}
            onChange={event => setSenderName(event.target.value)}
            autoComplete="name"
            placeholder="Optional"
          />
        </FieldRow>

        <label className="flex min-h-11 items-start gap-2.5 text-base text-paper lg:min-h-0">
          <input
            type="checkbox"
            checked={isSendOnly}
            onChange={event => setIsSendOnly(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-signal"
          />
          <span>
            Send-only
            <span className="block text-2xs text-paper-faint">
              Only appears in the From switch. Nothing is read from it.
            </span>
          </span>
        </label>

        <fieldset className="space-y-1.5">
          <legend className="label-rule mb-1.5">Servers</legend>
          {lookup.state === 'done' && !showFields && found !== null ? (
            <div className="border-t border-rule">
              <dl>
                {needsImap && found.imap !== null && (
                  <Definition term="IMAP">
                    {found.imap.host}:{found.imap.port}
                  </Definition>
                )}
                {found.smtp !== null && (
                  <Definition term="SMTP">
                    {found.smtp.host}:{found.smtp.port}
                  </Definition>
                )}
              </dl>
              <div className="mt-2 flex items-center justify-between gap-4">
                <p className="text-2xs text-paper-faint" aria-live="polite">
                  {lookupNote}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setIsEditingServers(true)}
                >
                  Edit servers
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-2xs text-paper-faint" aria-live="polite">
                {lookupNote}
              </p>
              {showFields && (
                <div className="space-y-4 pt-2">
                  {needsImap && (
                    <ServerFields
                      protocol="IMAP"
                      idPrefix="connect-imap"
                      host={servers.imapHost}
                      port={servers.imapPort}
                      onHost={setServer('imapHost')}
                      onPort={setServer('imapPort')}
                    />
                  )}
                  <ServerFields
                    protocol="SMTP"
                    idPrefix="connect-smtp"
                    host={servers.smtpHost}
                    port={servers.smtpPort}
                    onHost={setServer('smtpHost')}
                    onPort={setServer('smtpPort')}
                  />
                  <p className="text-2xs text-paper-faint">
                    Implicit TLS only: IMAP on 993, SMTP on 465. STARTTLS ports (143, 587) are not
                    reachable through the relay.
                  </p>
                </div>
              )}
            </>
          )}
        </fieldset>

        <FieldRow label="Username" htmlFor="connect-username">
          <Input
            id="connect-username"
            required
            autoComplete="username"
            value={username}
            onChange={event => {
              usernameEdited.current = true;
              setIsUsernameEdited(true);
              setUsername(event.target.value);
            }}
            className="font-mono"
          />
        </FieldRow>
        <FieldRow
          label="Password"
          htmlFor="connect-password"
          hint="An app password if your provider issues them. Gmail and iCloud require one."
        >
          <Input
            id="connect-password"
            type="password"
            required
            autoComplete="off"
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </FieldRow>

        {error !== null && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={isBusy}>
          {isBusy ? 'Checking…' : 'Add address'}
        </Button>
      </form>
    </PageColumn>
  );
};

/** Host and port as one ruled line. */
const ServerFields = ({
  protocol,
  idPrefix,
  host,
  port,
  onHost,
  onPort,
}: {
  protocol: 'IMAP' | 'SMTP';
  idPrefix: string;
  host: string;
  port: string;
  onHost: (value: string) => void;
  onPort: (value: string) => void;
}) => (
  <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
    <FieldRow label={`${protocol} host`} htmlFor={`${idPrefix}-host`}>
      <Input
        id={`${idPrefix}-host`}
        required
        value={host}
        onChange={event => onHost(event.target.value)}
        placeholder={protocol === 'IMAP' ? 'imap.example.com' : 'smtp.example.com'}
        className="font-mono"
      />
    </FieldRow>
    <FieldRow label="Port" htmlFor={`${idPrefix}-port`}>
      <Input
        id={`${idPrefix}-port`}
        required
        inputMode="numeric"
        value={port}
        onChange={event => onPort(event.target.value)}
        className="font-mono"
      />
    </FieldRow>
  </div>
);
