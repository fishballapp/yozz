import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState } from 'react';
import { Button, LinkButton } from '../ui/Button';
import { FieldRow, Input, PasswordInput } from '../ui/Field';
import { AuthColumn, authActionClass, authHeadingClass, authProseClass } from './AuthColumn';
import { requestRecoveryLink } from './auth-client';
import { LinkSentActions } from './LinkSentActions';
import { vaultErrorMessage } from './screen-policy';
import { useVault } from './session';
import { loginWithPasskey, loginWithPassword } from './unlock';

/** Sends the recovery link; resolves to what went wrong, or null once it is on its way. */
const sendRecoveryLink = async (email: string): Promise<string | null> => {
  try {
    const res = await requestRecoveryLink(email);
    if (res.error) return res.error.message || 'The login link could not be sent.';
    return null;
  } catch (err) {
    return vaultErrorMessage(err);
  }
};

/**
 * Only ever the approve page: the query is the one part of the URL a link to here can choose.
 * ponytail: the router re-spells a query it navigates to through its own parse, so a name such as
 * `1e3` arrives as `1000` and the page refuses the link; no hostname looks like that.
 */
const approvalHref = (query: string) => `/cli/approve?${query}`;

export const Login = ({
  isAccountDeleted = false,
  cliApproval,
}: {
  isAccountDeleted?: boolean;
  /** The query of the CLI approval that sent the person here, which an unlock goes back to. */
  cliApproval?: string;
}) => {
  const navigate = useNavigate();
  const { session, isResuming, setSession } = useVault();

  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const [busyKind, setBusyKind] = useState<'passkey' | 'password' | 'recover' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPanel, setErrorPanel] = useState<'passkey' | 'password' | 'recover' | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  const isBusy = busyKind !== null;

  const navigateOnward = () =>
    cliApproval === undefined
      ? navigate({
          to: '/m/$view',
          params: { view: 'unified' },
          search: previous => previous,
        })
      : navigate({ href: approvalHref(cliApproval), replace: true });

  // One session per tab for now: an unlocked vault has nowhere to log in to. Multi-account
  // sessions, when they come, replace this redirect with an account switch.
  if (isResuming) return null;
  if (session !== null) {
    if (cliApproval !== undefined) {
      return <Navigate to="/cli/approve" href={approvalHref(cliApproval)} replace />;
    }
    return (
      <Navigate to="/m/$view" params={{ view: 'unified' }} search={previous => previous} replace />
    );
  }

  const footer = (
    <p className="text-base text-paper-dim">
      No account yet?{' '}
      <Link to="/welcome" search={previous => previous} className="text-paper underline">
        Create one
      </Link>
      .
    </p>
  );

  const backToLogin = (
    <LinkButton
      onClick={() => {
        setMode('login');
        setError(null);
        setSentTo(null);
      }}
    >
      Back to logging in
    </LinkButton>
  );

  if (mode === 'recover') {
    if (sentTo !== null) {
      return (
        <AuthColumn
          title="Check your inbox"
          description={`We sent a recovery link to ${sentTo} from no-reply@yozz.app. It works for 10 minutes.`}
          footer={footer}
        >
          <LinkSentActions resend={() => sendRecoveryLink(sentTo)}>{backToLogin}</LinkSentActions>
          {import.meta.env.DEV && (
            <div className="mt-6 border-y border-rule bg-ink-raised px-4 py-3.5">
              <p className="label-rule">Dev</p>
              <p className={cn('mt-2', authProseClass)}>
                There is no mailbox on localhost. The link is printed in the wrangler dev terminal
                running the API worker.
              </p>
            </div>
          )}
        </AuthColumn>
      );
    }

    return (
      <AuthColumn title="Log in" footer={footer}>
        <h2 className={authHeadingClass}>Recover your account</h2>
        <p className={cn('mt-3', authProseClass)}>
          A recovery link gets you back into your account, but it can't unlock your saved addresses.
          You start again and add each address back, with a new password from its provider. It takes
          about ten minutes.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={async event => {
            event.preventDefault();
            setBusyKind('recover');
            setError(null);
            const failure = await sendRecoveryLink(recoveryEmail);
            setBusyKind(null);
            if (failure !== null) {
              setError(failure);
              setErrorPanel('recover');
              return;
            }
            setSentTo(recoveryEmail);
          }}
        >
          <FieldRow label="Email address" htmlFor="recover-email">
            <Input
              id="recover-email"
              type="email"
              required
              autoComplete="email"
              value={recoveryEmail}
              onChange={event => setRecoveryEmail(event.target.value)}
              disabled={isBusy}
            />
          </FieldRow>
          {error !== null && errorPanel === 'recover' && (
            <p role="alert" className="text-base text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="secondary" className={authActionClass} disabled={isBusy}>
            {busyKind === 'recover' ? 'Sending…' : 'Send recovery link'}
          </Button>
        </form>
        <div className="mt-8">{backToLogin}</div>
      </AuthColumn>
    );
  }

  return (
    <AuthColumn title="Log in" footer={footer}>
      {isAccountDeleted && (
        <p role="status" aria-live="polite" className="mb-6 text-base text-paper">
          Your account was deleted.
        </p>
      )}
      <div className="space-y-4">
        <Button
          variant="primary"
          className={authActionClass}
          disabled={isBusy}
          onClick={async () => {
            setBusyKind('passkey');
            setError(null);
            try {
              setSession(await loginWithPasskey());
              void navigateOnward();
            } catch (err) {
              setError(vaultErrorMessage(err));
              setErrorPanel('passkey');
            } finally {
              setBusyKind(null);
            }
          }}
        >
          {busyKind === 'passkey' ? 'Waiting for your authenticator…' : 'Log in with a passkey'}
        </Button>
        {error !== null && errorPanel === 'passkey' && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
      </div>

      <form
        className="mt-8 space-y-4 border-t border-rule-soft pt-8"
        onSubmit={async event => {
          event.preventDefault();
          setBusyKind('password');
          setError(null);
          try {
            const session = await loginWithPassword({ email, password });
            setSession(session);
            void navigateOnward();
          } catch (err) {
            setError(vaultErrorMessage(err));
            setErrorPanel('password');
          } finally {
            setBusyKind(null);
          }
        }}
      >
        <h2 className={authHeadingClass}>Or use your password</h2>
        <FieldRow label="Email address" htmlFor="login-email">
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <FieldRow label="Password" htmlFor="login-password">
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <Button type="submit" variant="secondary" className={authActionClass} disabled={isBusy}>
          {busyKind === 'password' ? 'Logging in…' : 'Log in'}
        </Button>
        {busyKind === 'password' && (
          <p className="text-2xs text-paper-faint">
            650,000 PBKDF2 rounds, in this tab. The browser cannot report progress on it.
          </p>
        )}
        {error !== null && errorPanel === 'password' && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
      </form>

      <LinkButton
        className="mt-8"
        onClick={() => {
          setMode('recover');
          setError(null);
          setSentTo(null);
        }}
      >
        Lost your passkey or password?
      </LinkButton>
    </AuthColumn>
  );
};
