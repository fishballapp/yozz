import { Link, useNavigate } from '@tanstack/react-router';
import {
  type AddressRecord,
  addressRecordSchema,
  isInbound,
} from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure } from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import type { MailAutoconfig } from '@yozz.app/vault-contract';
import { cn } from 'cn';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ZodError } from 'zod';
import {
  type AutoconfigLookup,
  domainOf,
  lookupMailServers,
  usernameFor,
} from '../../addresses/autoconfig';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { Button, buttonClass, linkClass } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { FieldRow, Input, PasswordInput } from '../../ui/Field';
import { Definition } from '../../ui/PageSection';
import { AuthColumn } from '../../vault/AuthColumn';
import { SetupSteps } from '../../vault/SetupSteps';
import { vaultErrorMessage } from '../../vault/screen-policy';
import { SettingsPane } from './SettingsPane';

/**
 * The steps are one list in order, all visible. A finished step is one line with its answer and a
 * Change that reopens it; the open step is its form; the rest wait under their titles. The domain is
 * looked up the way Thunderbird looks it up (autoconfig, ISPDB, the MX host's entry, SRV); a domain
 * that publishes nothing gets the fields. The password is tried against each server before the
 * record is written.
 *
 * The first address is the last step of setting up an account, so with `isFirst` it renders in the
 * bare frame welcome and enrol use, under their step line: its own steps go unnumbered there (a "3"
 * over "1 2 3" reads as two counters), and the way out is Skip for now, not a Cancel back to this
 * same screen.
 */

type StepId = 'address' | 'servers' | 'signin';

const STEPS: Record<StepId, { readonly number: number; readonly title: string }> = {
  address: { number: 1, title: 'Address' },
  servers: { number: 2, title: 'Servers' },
  // The provider's password, not a YOZZ login.
  signin: { number: 3, title: 'Password' },
};

/** Google takes only an app password over IMAP and SMTP, and makes it on this page. */
const GOOGLE_APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';

/** A Google address, or one whose servers are Google's (a Workspace domain). */
const isGoogleMail = (address: string, servers: Servers): boolean => {
  const isGoogleHost = (host: string) => {
    const name = host.trim().toLowerCase();
    return name === 'gmail.com' || name === 'googlemail.com' || name.endsWith('.gmail.com');
  };
  return (
    isGoogleHost(domainOf(address) ?? '') ||
    isGoogleHost(servers.imapHost) ||
    isGoogleHost(servers.smtpHost)
  );
};

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

/** Whether this is the account's first address, read by the step parts below. */
const IsFirstAddress = createContext(false);

const SUBLINE =
  "An address you already own. Its password is checked with your provider before it's saved.";

export const AddAddress = ({ isFirst = false }: { isFirst?: boolean }) => {
  const navigate = useNavigate();
  // The setup frame is on `--ink`; the settings pane is sunken.
  const ground = isFirst ? 'page' : 'sunken';
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
            to: '/m/$view',
            params: { view: record.address },
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
          ground={ground}
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
        ground={ground}
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

  const steps = (
    <IsFirstAddress.Provider value={isFirst}>
      <div className="max-w-xl">
        <fieldset disabled={busyLabel !== null} className="m-0 min-w-0 border-0 p-0">
          {open === 'address' ? (
            <OpenStep step="address">
              <form onSubmit={continueFromAddress}>
                <div className="space-y-6">
                  <FieldRow label="Address to connect" htmlFor="connect-address">
                    <Input
                      ground={ground}
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
                      ground={ground}
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
            </OpenStep>
          ) : (
            <StepLine
              step="address"
              answer={done.has('address') ? addressAnswer : undefined}
              onChange={done.has('address') ? () => reopen('address') : undefined}
            />
          )}

          {open === 'servers' ? (
            <OpenStep step="servers" error={serversProblem}>
              <form onSubmit={continueFromServers}>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the input inside the label. */}
                <label className="mb-4 flex min-h-11 items-start gap-2.5 text-base text-paper lg:min-h-0">
                  <Checkbox
                    label="Send-only"
                    checked={isSendOnly}
                    onCheckedChange={checked => setIsSendOnly(checked)}
                    className="h-5 w-3.25 shrink-0"
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
            </OpenStep>
          ) : (
            <StepLine
              step="servers"
              answer={done.has('servers') ? serversAnswer : undefined}
              onChange={done.has('servers') ? () => reopen('servers') : undefined}
              error={problem?.at === 'server' ? problem.message : null}
            />
          )}

          {open === 'signin' ? (
            <OpenStep step="signin">
              <form onSubmit={submit}>
                <div className="space-y-6">
                  <FieldRow label="Username" htmlFor="connect-username">
                    <Input
                      ground={ground}
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
                    hint={
                      isGoogleMail(lookedUpFor ?? '', servers) ? (
                        <>
                          Gmail needs an app password, not your Google password.{' '}
                          <a
                            href={GOOGLE_APP_PASSWORDS}
                            target="_blank"
                            rel="noreferrer"
                            className="text-paper-dim underline underline-offset-2 hover:text-paper"
                          >
                            Make one at Google
                          </a>
                          .
                        </>
                      ) : (
                        'An app password if your provider issues them. iCloud requires one.'
                      )
                    }
                  >
                    <PasswordInput
                      id="connect-password"
                      ground={ground}
                      aria-describedby="connect-password-hint"
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
            </OpenStep>
          ) : (
            <StepLine step="signin" />
          )}
        </fieldset>
      </div>
    </IsFirstAddress.Provider>
  );

  if (isFirst) {
    return (
      <AuthColumn
        title="Connect an address"
        description={SUBLINE}
        progress={<SetupSteps current={3} />}
        footer={
          <Link
            to="/m/$view"
            params={{ view: 'unified' }}
            search={keepCompose}
            className={linkClass}
          >
            Skip for now
          </Link>
        }
      >
        {steps}
      </AuthColumn>
    );
  }

  return (
    <SettingsPane title="Add an address" subline={SUBLINE}>
      {steps}
    </SettingsPane>
  );
};

type StepState = 'open' | 'done' | 'pending';

const STEP_TONE: Record<StepState, string> = {
  open: 'text-paper',
  done: 'text-paper-dim',
  pending: 'text-paper-faint',
};

/** A step's number and title; the open one is lit, the ones not reached yet are faint. */
const StepHeading = ({ step, state }: { step: StepId; state: StepState }) => {
  const isFirst = useContext(IsFirstAddress);
  return (
    <h3
      aria-current={state === 'open' ? 'step' : undefined}
      className={cn(
        'flex items-baseline gap-2.5 text-[15px] leading-snug font-medium',
        STEP_TONE[state],
      )}
    >
      {!isFirst && <span className="w-2 font-mono text-2xs">{STEPS[step].number}</span>}
      {STEPS[step].title}
    </h3>
  );
};

/**
 * A step that is not open: its heading, its answer when it is finished, and Change to reopen it. A
 * step that has not been reached shows only its heading, faint. On the first address the last line
 * drops its rule: the auth frame's footer rule closes the list, and two would frame an empty band.
 */
const StepLine = ({
  step,
  answer,
  onChange,
  error = null,
}: {
  step: StepId;
  answer?: ReactNode;
  onChange?: () => void;
  error?: string | null;
}) => {
  const isFirst = useContext(IsFirstAddress);
  return (
    <div className={cn('border-b border-rule-soft', isFirst && 'last:border-b-0')}>
      <div className="flex min-h-11 items-center gap-4 py-2.5">
        <div className="w-28 shrink-0">
          <StepHeading step={step} state={answer === undefined ? 'pending' : 'done'} />
        </div>
        {answer !== undefined && (
          <span className="min-w-0 flex-1 font-mono text-2xs text-paper">{answer}</span>
        )}
        {onChange !== undefined && (
          <Button variant="ghost" size="sm" className="-mr-2.5 ml-auto shrink-0" onClick={onChange}>
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
};

/**
 * The open step: its heading over a rule, its form, and what went wrong with it; space above it when
 * finished steps come first.
 */
const OpenStep = ({
  step,
  error = null,
  children,
}: {
  step: StepId;
  error?: string | null;
  children: ReactNode;
}) => (
  <section className="mt-10 mb-8 first:mt-0 last:mb-0">
    <div className="border-b border-rule pb-2">
      <StepHeading step={step} state="open" />
    </div>
    <div className="mt-4">{children}</div>
    {error !== null && (
      <p role="alert" className="mt-3 max-w-xl text-base text-danger">
        {error}
      </p>
    )}
  </section>
);

/**
 * The step's own action first, Cancel after it, from the left like every other action row. The first
 * address has no Cancel: it led to `/settings`, which is this same screen, and Skip for now is the
 * way out there.
 */
const StepActions = ({ children, onCancel }: { children: ReactNode; onCancel?: () => void }) => {
  const isFirst = useContext(IsFirstAddress);
  return (
    <div className="mt-8 flex flex-wrap items-center gap-2">
      {children}
      {!isFirst && (
        <Link
          to="/settings"
          search={keepCompose}
          onClick={onCancel}
          className={buttonClass({ variant: 'ghost' })}
        >
          Cancel
        </Link>
      )}
    </div>
  );
};

/** Host and port as one ruled line. */
const ServerFields = ({
  protocol,
  ground,
  idPrefix,
  autoFocus,
  host,
  port,
  onHost,
  onPort,
}: {
  protocol: 'IMAP' | 'SMTP';
  ground: 'page' | 'sunken';
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
        ground={ground}
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
        ground={ground}
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
