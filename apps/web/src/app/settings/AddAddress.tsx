import { Link, useNavigate } from '@tanstack/react-router';
import {
  type AddressRecord,
  addressRecordSchema,
  isInbound,
} from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure } from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import type { MailAutoconfig } from '@yozz.app/vault-contract';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ZodError } from 'zod';
import {
  type AutoconfigLookup,
  domainOf,
  lookupMailServers,
  usernameFor,
} from '../../addresses/autoconfig';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { Button, buttonClass } from '../../ui/Button';
import { FieldRow, Input } from '../../ui/Field';
import { Definition, PageSection } from '../../ui/PageSection';
import { vaultErrorMessage } from '../../vault/screen-policy';
import { SettingsPane } from './SettingsPane';

/**
 * The steps are one list in order, all visible. A finished step is one line with its answer and a
 * Change that reopens it; the open step is its form; the rest wait under their titles. The domain is
 * looked up the way Thunderbird looks it up (autoconfig, ISPDB, the MX host's entry, SRV); a domain
 * that publishes nothing gets the fields. The password is tried against each server before the
 * record is written.
 */

type StepId = 'address' | 'servers' | 'signin';

const STEP_NUMBER: Record<StepId, number> = { address: 1, servers: 2, signin: 3 };

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

/** A failure, and the step or field it is said under. */
type Problem = {
  readonly at: 'address' | 'servers' | 'server' | 'password' | 'submit';
  readonly message: string;
};

const BLANK_SERVERS: Servers = { imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465' };

const SERVERS_INVALID = 'Enter a host and a port for each server.';

/** The servers a lookup found. A protocol the provider did not name keeps its blank port. */
const serversFrom = (config: MailAutoconfig): Servers => ({
  imapHost: config.imap?.host ?? '',
  imapPort: config.imap === null ? BLANK_SERVERS.imapPort : String(config.imap.port),
  smtpHost: config.smtp?.host ?? '',
  smtpPort: config.smtp === null ? BLANK_SERVERS.smtpPort : String(config.smtp.port),
});

const isPort = (value: string): boolean =>
  /^\d+$/.test(value) && Number(value) <= 65535 && Number(value) >= 1;

const serversAreValid = (servers: Servers, needsImap: boolean): boolean =>
  servers.smtpHost.trim() !== '' &&
  isPort(servers.smtpPort) &&
  (!needsImap || (servers.imapHost.trim() !== '' && isPort(servers.imapPort)));

/** A refused login is said under the password; anything else is about a server. */
const problemFor = (failure: MailConnectionFailure, host: string): Problem => ({
  at: failure.kind === 'auth' ? 'password' : 'server',
  message: describeMailFailure(failure, host),
});

/** Demo mode answers from the fixtures in development only; a production demo has nothing to ask. */
const demoLookup = async (domain: string): Promise<AutoconfigLookup> => {
  if (!import.meta.env.DEV) return { status: 'unavailable' };
  const { demoAutoconfig } = await import('../../dev/fixtures');
  return demoAutoconfig(domain);
};

export const AddAddress = () => {
  const navigate = useNavigate();
  const { identities, putAddress, watchSession, isDemo: demo } = useMail();

  const [open, setOpen] = useState<StepId>('address');
  const [done, setDone] = useState<ReadonlySet<StepId>>(() => new Set());
  const [senderName, setSenderName] = useState('');
  const [address, setAddress] = useState('');
  // The address the servers were looked up for; null until a lookup has landed.
  const [lookedUpFor, setLookedUpFor] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  // Only the latest lookup may land: one superseded by a later address is dropped.
  const lookupSeq = useRef(0);
  const [isSendOnly, setIsSendOnly] = useState(false);
  const [servers, setServers] = useState<Servers>(BLANK_SERVERS);
  const [isEditingServers, setIsEditingServers] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  // What the submit is doing now, on its button; null when nothing is running.
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  // Each submit takes a number. Cancel and leaving the page move the number on, so an add in flight
  // stops before its next step (the next test, the store, the navigation).
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const domain = lookup.state === 'done' ? lookup.domain : '';
  const found =
    lookup.state === 'done' && lookup.result.status === 'found' ? lookup.result.config : null;
  const needsImap = !isSendOnly;
  // A complete found set is shown as facts; anything missing, or never found, is typed in.
  const isComplete = found !== null && found.smtp !== null && (!needsImap || found.imap !== null);
  const showFacts = isComplete && !isEditingServers;
  const serversProblem =
    problem !== null && (problem.at === 'servers' || problem.at === 'server')
      ? problem.message
      : null;

  const mark = (step: StepId, isDone: boolean) =>
    setDone(current => {
      const next = new Set(current);
      if (isDone) {
        next.add(step);
      } else {
        next.delete(step);
      }
      return next;
    });

  const clearProblem = (at: Problem['at']) =>
    setProblem(current => (current?.at === at ? null : current));

  /** Reopens a step. An address typed but not yet looked up is dropped, so no step can use it. */
  const reopen = (step: StepId) => {
    if (lookedUpFor !== null) setAddress(lookedUpFor);
    setOpen(step);
  };

  /** Asks for the domain's servers only; the address itself stays here. Resolves true once its answer lands. */
  const lookUp = async (domainToFind: string, forAddress: string): Promise<boolean> => {
    lookupSeq.current += 1;
    const seq = lookupSeq.current;
    setLookup({ state: 'looking', domain: domainToFind });
    // The servers and username belong to the address they were looked up for, so a new address resets them.
    setServers(BLANK_SERVERS);
    setIsEditingServers(false);
    setUsername(forAddress);
    mark('servers', false);
    setProblem(current => (current?.at === 'servers' || current?.at === 'server' ? null : current));
    const result = demo ? await demoLookup(domainToFind) : await lookupMailServers(domainToFind);
    if (seq !== lookupSeq.current) return false;
    setLookup({ state: 'done', domain: domainToFind, result });
    setLookedUpFor(forAddress);
    if (result.status === 'found') {
      setServers(serversFrom(result.config));
      setUsername(usernameFor(forAddress, result.config.username));
    }
    return true;
  };

  const continueFromAddress = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = address.trim();
    // The address is the natural key, so a second record would replace the first.
    if (identities.some(existing => existing.address === trimmed)) {
      setProblem({
        at: 'address',
        message: 'That address is already stored. Open it from Settings.',
      });
      return;
    }
    const nextDomain = domainOf(trimmed);
    if (nextDomain === null) {
      setProblem({ at: 'address', message: 'Enter a full email address.' });
      return;
    }
    setProblem(null);
    if (trimmed === lookedUpFor) {
      mark('address', true);
      setOpen('servers');
      return;
    }
    // A session that ends during the lookup must not carry the flow into the next one.
    const isCurrent = watchSession();
    void lookUp(nextDomain, trimmed).then(landed => {
      if (!landed || !isCurrent()) return;
      mark('address', true);
      setOpen('servers');
    });
  };

  const continueFromServers = (event: FormEvent) => {
    event.preventDefault();
    if (!serversAreValid(servers, needsImap)) {
      setProblem({ at: 'servers', message: SERVERS_INVALID });
      return;
    }
    setProblem(null);
    setIsEditingServers(false);
    mark('servers', true);
    setOpen('signin');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // A lock or a sign-in during the checks ends the session this address was typed into, and its
    // credentials must not be stored, shown or synced in the next one.
    const isCurrent = watchSession();
    const attemptId = attempt.current + 1;
    attempt.current = attemptId;
    const isLive = () => isCurrent() && attempt.current === attemptId;
    void (async () => {
      setBusyLabel('Checking…');
      setProblem(null);
      try {
        // The address that was validated and looked up, never whatever the field says now.
        const validated = lookedUpFor ?? '';
        const login = username.trim() === '' ? validated : username.trim();
        const record: AddressRecord = addressRecordSchema.parse({
          address: validated,
          ...(senderName.trim() === '' ? {} : { senderName: senderName.trim() }),
          smtp: {
            host: servers.smtpHost.trim(),
            port: Number(servers.smtpPort),
            username: login,
            password,
          },
          ...(isSendOnly
            ? {}
            : {
                imap: {
                  host: servers.imapHost.trim(),
                  port: Number(servers.imapPort),
                  username: login,
                  password,
                },
              }),
        });
        if (!demo) {
          // Both tried before anything is stored. The TLS stack loads on demand.
          if (isInbound(record)) {
            setBusyLabel(`Testing ${record.imap.host}…`);
            const { testImap } = await import('../../relay/probe');
            if (!isLive()) return;
            const test = await testImap(record.imap);
            if (!isLive()) return;
            if (!test.ok) {
              setProblem(problemFor(test.error, record.imap.host));
              return;
            }
          }
          setBusyLabel(`Testing ${record.smtp.host}…`);
          const { testSmtp } = await import('../../relay/probe');
          if (!isLive()) return;
          const test = await testSmtp(record.smtp);
          if (!isLive()) return;
          if (!test.ok) {
            setProblem(problemFor(test.error, record.smtp.host));
            return;
          }
        }
        setBusyLabel('Adding…');
        if (!isLive()) return;
        await putAddress(record);
        if (!isLive()) return;
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
        if (!isLive()) return;
        if (err instanceof ZodError) {
          const first = err.issues[0];
          setProblem({
            at: 'submit',
            message: first === undefined ? 'That form is not valid.' : first.message,
          });
        } else {
          setProblem({ at: 'submit', message: vaultErrorMessage(err) });
        }
      } finally {
        if (attempt.current === attemptId) setBusyLabel(null);
      }
    })();
  };

  /** What the lookup said about the servers, in one line. */
  const serversNote = (): string => {
    if (found !== null) {
      return isComplete
        ? `Found ${domain}'s settings.`
        : `Found part of ${domain}'s settings. Enter the rest.`;
    }
    return `Nothing was found for ${domain}. Your provider's help pages list these settings. Only ports 993 and 465 work through the relay.`;
  };

  const setServer = (key: keyof Servers) => (value: string) =>
    setServers(current => ({ ...current, [key]: value }));

  const serverFields = (
    <div className="space-y-4">
      {needsImap && (
        <ServerFields
          protocol="IMAP"
          idPrefix="connect-imap"
          autoFocus={needsImap}
          host={servers.imapHost}
          port={servers.imapPort}
          onHost={setServer('imapHost')}
          onPort={setServer('imapPort')}
        />
      )}
      <ServerFields
        protocol="SMTP"
        idPrefix="connect-smtp"
        autoFocus={!needsImap}
        host={servers.smtpHost}
        port={servers.smtpPort}
        onHost={setServer('smtpHost')}
        onPort={setServer('smtpPort')}
      />
    </div>
  );

  const addressAnswer = (
    <>
      <span className="block">{lookedUpFor}</span>
      {senderName.trim() !== '' && <span className="block">{senderName.trim()}</span>}
    </>
  );

  const serversAnswer = isSendOnly ? (
    <span className="block">
      {servers.smtpHost}:{servers.smtpPort}
    </span>
  ) : (
    <>
      <span className="block">
        {servers.imapHost}:{servers.imapPort}
      </span>
      <span className="block">
        {servers.smtpHost}:{servers.smtpPort}
      </span>
    </>
  );

  return (
    <SettingsPane
      title="Add an address"
      subline="An address you already own. Its password is checked with your provider before it's saved."
    >
      <div className="max-w-xl">
        <fieldset disabled={busyLabel !== null} className="m-0 min-w-0 border-0 p-0">
          {open === 'address' ? (
            <OpenStep>
              <PageSection label="Address">
                <form onSubmit={continueFromAddress}>
                  <StepNumber step="address" />
                  <div className="space-y-6">
                    <FieldRow label="Email address" htmlFor="connect-address">
                      <Input
                        id="connect-address"
                        type="email"
                        required
                        autoComplete="email"
                        autoFocus
                        readOnly={lookup.state === 'looking'}
                        value={address}
                        onChange={event => {
                          setAddress(event.target.value);
                          clearProblem('address');
                        }}
                        placeholder="you@yourdomain.com"
                      />
                      {problem?.at === 'address' && (
                        <p role="alert" className="text-base text-danger">
                          {problem.message}
                        </p>
                      )}
                    </FieldRow>
                    <FieldRow
                      label="Name"
                      htmlFor="connect-name"
                      hint="Shown next to this address on mail you send."
                    >
                      <Input
                        id="connect-name"
                        autoComplete="name"
                        placeholder="Optional"
                        value={senderName}
                        onChange={event => setSenderName(event.target.value)}
                      />
                    </FieldRow>
                  </div>
                  {lookup.state === 'looking' && (
                    <p className="mt-2 text-2xs text-paper-faint" aria-live="polite">
                      Looking up mail servers for {lookup.domain}…
                    </p>
                  )}
                  <StepActions>
                    <Button type="submit" variant="primary" disabled={lookup.state === 'looking'}>
                      {lookup.state === 'looking' ? 'Looking up…' : 'Continue'}
                    </Button>
                  </StepActions>
                </form>
              </PageSection>
            </OpenStep>
          ) : (
            <StepLine
              title="Address"
              answer={done.has('address') ? addressAnswer : undefined}
              onChange={done.has('address') ? () => reopen('address') : undefined}
            />
          )}

          {open === 'servers' ? (
            <OpenStep>
              <PageSection label="Servers" error={serversProblem}>
                <form onSubmit={continueFromServers}>
                  <StepNumber step="servers" />
                  <label className="mb-4 flex min-h-11 items-start gap-2.5 text-base text-paper lg:min-h-0">
                    <input
                      type="checkbox"
                      checked={isSendOnly}
                      onChange={event => setIsSendOnly(event.target.checked)}
                      className="mt-0.5 size-4 shrink-0 accent-signal"
                    />
                    <span>
                      Send-only
                      <span className="block text-2xs text-paper-faint">
                        Only send from this address; its inbox isn't read here.
                      </span>
                    </span>
                  </label>
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-base text-paper-dim">{serversNote()}</p>
                    {showFacts && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-2.5 shrink-0"
                        autoFocus
                        onClick={() => setIsEditingServers(true)}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                  {showFacts ? (
                    <dl className="mt-3">
                      {needsImap && (
                        <Definition term="IMAP">
                          {servers.imapHost}:{servers.imapPort}
                        </Definition>
                      )}
                      <Definition term="SMTP">
                        {servers.smtpHost}:{servers.smtpPort}
                      </Definition>
                    </dl>
                  ) : (
                    <div className="mt-4 space-y-4">{serverFields}</div>
                  )}
                  <StepActions>
                    <Button type="submit" variant="primary">
                      Continue
                    </Button>
                  </StepActions>
                </form>
              </PageSection>
            </OpenStep>
          ) : (
            <StepLine
              title="Servers"
              answer={done.has('servers') ? serversAnswer : undefined}
              onChange={done.has('servers') ? () => reopen('servers') : undefined}
              error={problem?.at === 'server' ? problem.message : null}
            />
          )}

          {open === 'signin' ? (
            <OpenStep>
              <PageSection label="Sign-in">
                <form onSubmit={submit}>
                  <StepNumber step="signin" />
                  <div className="space-y-6">
                    <FieldRow label="Username" htmlFor="connect-username">
                      <Input
                        id="connect-username"
                        required
                        autoFocus
                        autoComplete="username"
                        value={username}
                        onChange={event => setUsername(event.target.value)}
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
                        onChange={event => {
                          setPassword(event.target.value);
                          clearProblem('password');
                        }}
                      />
                      {problem?.at === 'password' && (
                        <p role="alert" className="text-base text-danger">
                          {problem.message}
                        </p>
                      )}
                    </FieldRow>
                  </div>
                  {problem?.at === 'submit' && (
                    <p role="alert" className="mt-6 text-base text-danger">
                      {problem.message}
                    </p>
                  )}
                  <StepActions onCancel={() => (attempt.current += 1)}>
                    <Button type="submit" variant="primary" disabled={busyLabel !== null}>
                      {busyLabel ?? 'Test and add'}
                    </Button>
                  </StepActions>
                </form>
              </PageSection>
            </OpenStep>
          ) : (
            <StepLine title="Sign-in" />
          )}
        </fieldset>
      </div>
    </SettingsPane>
  );
};

/** The step's number, as its place in the three. */
const StepNumber = ({ step }: { step: StepId }) => (
  <p className="mb-4 text-2xs text-paper-faint">Step {STEP_NUMBER[step]} of 3</p>
);

/**
 * A step that is not open: its title, its answer when it is finished, and Change to reopen it. A
 * step that has not been reached shows only its title, faint, the way a label does.
 */
const StepLine = ({
  title,
  answer,
  onChange,
  error = null,
}: {
  title: string;
  answer?: ReactNode;
  onChange?: () => void;
  error?: string | null;
}) => (
  <div className="border-b border-rule-soft">
    <div className="flex items-center gap-4 py-2.5">
      <span className="label-rule w-24 shrink-0">{title}</span>
      {answer !== undefined && (
        <span className="min-w-0 flex-1 font-mono text-2xs text-paper">{answer}</span>
      )}
      {onChange !== undefined && (
        <Button variant="ghost" size="sm" className="-mr-2.5 shrink-0" onClick={onChange}>
          Change
        </Button>
      )}
    </div>
    {error !== null && (
      <p role="alert" className="pb-2.5 text-base text-danger">
        {error}
      </p>
    )}
  </div>
);

/** The open step, with the space above it that a finished run needs; none when it is first. */
const OpenStep = ({ children }: { children: ReactNode }) => (
  <div className="mt-10 first:mt-0">{children}</div>
);

/** Cancel on the left, the step's own action after it. */
const StepActions = ({ children, onCancel }: { children: ReactNode; onCancel?: () => void }) => (
  <div className="mt-8 flex items-center justify-end gap-2">
    <Link
      to="/settings"
      search={keepCompose}
      onClick={onCancel}
      className={buttonClass({ variant: 'ghost' })}
    >
      Cancel
    </Link>
    {children}
  </div>
);

/** Host and port as one ruled line. */
const ServerFields = ({
  protocol,
  idPrefix,
  autoFocus,
  host,
  port,
  onHost,
  onPort,
}: {
  protocol: 'IMAP' | 'SMTP';
  idPrefix: string;
  autoFocus: boolean;
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
        autoFocus={autoFocus}
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
