import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthColumn } from '../components/AuthColumn';
import { Button } from '../components/ui/Button';
import { FieldRow, Input } from '../components/ui/Field';
import { agentLabel } from '../lib/agent-label';
import { requestRecoveryLink } from '../vault/auth-client.ts';
import { vaultErrorMessage } from '../vault/screen-policy.ts';
import { useVault } from '../vault/session.tsx';
import { loginWithPasskey, loginWithPassword } from '../vault/unlock.ts';

export const Login = () => {
  const navigate = useNavigate();
  const { setSession } = useVault();

  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const [busyKind, setBusyKind] = useState<'passkey' | 'password' | 'recover' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPanel, setErrorPanel] = useState<'passkey' | 'password' | 'recover' | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  const isBusy = busyKind !== null;

  const footer = (
    <p className="text-base text-paper-dim">
      No account yet?{' '}
      <Link to="/welcome" search={previous => previous} className="text-paper underline">
        Create one
      </Link>
      .
    </p>
  );

  if (mode === 'recover') {
    if (sentTo !== null) {
      return (
        <AuthColumn
          title="Log in"
          description={`A sign-in link is on its way to ${sentTo}. It is valid for 10 minutes.`}
          footer={footer}
        >
          <h2 className="label-rule">Recover the account</h2>
          <p className="mt-3 text-base text-paper-dim">Check your inbox.</p>
          {import.meta.env.DEV && (
            <div className="mt-6 border-y border-rule bg-ink-raised px-4 py-3.5">
              <p className="label-rule">Dev</p>
              <p className="mt-2 text-base leading-relaxed text-paper-dim">
                There is no mailbox on localhost. The link is printed in the wrangler dev terminal
                running the API worker.
              </p>
            </div>
          )}
          <Button variant="ghost" className="mt-4" onClick={() => setMode('login')}>
            Back to logging in
          </Button>
        </AuthColumn>
      );
    }

    return (
      <AuthColumn title="Log in" footer={footer}>
        <h2 className="label-rule">Recover the account</h2>
        <p className="mt-3 text-base leading-relaxed text-paper-dim">
          A recovery link restores your YOZZ account, not your vault. It proves your address and
          holds no key, so it cannot open a single record. What follows is a vault reset and adding
          your accounts again: ten minutes, and nothing lost, because every credential in there can
          be made again at your provider.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={event => {
            event.preventDefault();
            void (async () => {
              setBusyKind('recover');
              setError(null);
              try {
                const res = await requestRecoveryLink(recoveryEmail);
                if (res.error) {
                  setError(res.error.message || 'The sign-in link could not be sent.');
                  setErrorPanel('recover');
                  return;
                }
                setSentTo(recoveryEmail);
              } catch (err) {
                setError(vaultErrorMessage(err));
                setErrorPanel('recover');
              } finally {
                setBusyKind(null);
              }
            })();
          }}
        >
          <FieldRow label="Email address" htmlFor="recover-email">
            <Input
              id="recover-email"
              aria-label={agentLabel('Email address', recoveryEmail)}
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
          <Button type="submit" variant="secondary" disabled={isBusy}>
            {busyKind === 'recover' ? 'Sending…' : 'Send recovery link'}
          </Button>
        </form>
        <Button
          variant="ghost"
          className="mt-4"
          onClick={() => {
            setMode('login');
            setError(null);
            setSentTo(null);
          }}
        >
          Back to logging in
        </Button>
      </AuthColumn>
    );
  }

  return (
    <AuthColumn title="Log in" footer={footer}>
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-paper-dim">
          If you enrolled a passkey, this is the whole login.
        </p>
        <Button
          variant="primary"
          disabled={isBusy}
          onClick={() => {
            void (async () => {
              setBusyKind('passkey');
              setError(null);
              try {
                setSession(await loginWithPasskey());
                void navigate({
                  to: '/m/$mailbox',
                  params: { mailbox: 'unified' },
                  search: previous => previous,
                });
              } catch (err) {
                setError(vaultErrorMessage(err));
                setErrorPanel('passkey');
              } finally {
                setBusyKind(null);
              }
            })();
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

      <div className="mt-8 space-y-4 border-t border-rule-soft pt-8">
        <h2 className="label-rule">Password</h2>
        <FieldRow label="Email address" htmlFor="login-email">
          <Input
            id="login-email"
            aria-label={agentLabel('Email address', email)}
            type="email"
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <FieldRow label="Password" htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <Button
          variant="secondary"
          disabled={isBusy}
          onClick={() => {
            void (async () => {
              setBusyKind('password');
              setError(null);
              try {
                const session = await loginWithPassword({ email, password });
                setSession(session);
                void navigate({
                  to: '/m/$mailbox',
                  params: { mailbox: 'unified' },
                  search: previous => previous,
                });
              } catch (err) {
                setError(vaultErrorMessage(err));
                setErrorPanel('password');
              } finally {
                setBusyKind(null);
              }
            })();
          }}
        >
          {busyKind === 'password' ? 'Deriving keys…' : 'Log in'}
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
      </div>

      <Button
        variant="ghost"
        className="mt-8"
        onClick={() => {
          setMode('recover');
          setError(null);
          setSentTo(null);
        }}
      >
        Lost your passkey or password?
      </Button>
    </AuthColumn>
  );
};
