import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AuthColumn } from '../components/AuthColumn';
import { Button } from '../components/ui/Button';
import { FieldRow, Input } from '../components/ui/Field';
import { agentLabel } from '../lib/agent-label';
import { requestSignupLink } from '../vault/auth-client.ts';
import { vaultErrorMessage } from '../vault/screen-policy.ts';

export const Welcome = () => {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <AuthColumn
        title="Check your inbox"
        description={`A sign-in link is on its way to ${sentTo}. It is valid for 10 minutes.`}
        footer={
          <p className="text-base text-paper-dim">
            Already have an account?{' '}
            <Link to="/login" search={previous => previous} className="text-paper underline">
              Log in
            </Link>
            .
          </p>
        }
      >
        <Button variant="ghost" onClick={() => setSentTo(null)}>
          Use a different address
        </Button>
        {import.meta.env.DEV && (
          <div className="mt-6 border-y border-rule bg-ink-raised px-4 py-3.5">
            <p className="label-rule">Dev</p>
            <p className="mt-2 text-base leading-relaxed text-paper-dim">
              There is no mailbox on localhost. The link is printed in the wrangler dev terminal
              running the API worker.
            </p>
          </div>
        )}
      </AuthColumn>
    );
  }

  return (
    <AuthColumn
      title="Create your YOZZ account"
      description="YOZZ reads mail from accounts you already own. First it needs an account of its own: that is what holds your settings, encrypted with a key that never leaves your devices."
      footer={
        <p className="text-base text-paper-dim">
          Already have an account?{' '}
          <Link to="/login" search={previous => previous} className="text-paper underline">
            Log in
          </Link>
          .
        </p>
      }
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          void (async () => {
            setIsBusy(true);
            setError(null);
            try {
              const res = await requestSignupLink(email);
              if (res.error) {
                setError(res.error.message || 'The sign-in link could not be sent.');
                return;
              }
              setSentTo(email);
            } catch (err) {
              setError(vaultErrorMessage(err));
            } finally {
              setIsBusy(false);
            }
          })();
        }}
      >
        <FieldRow
          label="Email address"
          htmlFor="welcome-email"
          hint="This address is permanent. It is part of how your vault key is derived, so it can never be changed later."
        >
          <Input
            id="welcome-email"
            aria-label={agentLabel('Email address', email)}
            type="email"
            required
            autoFocus
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        {error !== null && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={isBusy}>
          {isBusy ? 'Sending…' : 'Send sign-in link'}
        </Button>
      </form>
    </AuthColumn>
  );
};
