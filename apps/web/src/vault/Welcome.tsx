import { CheckIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState } from 'react';
import { Button, LinkButton } from '../ui/Button';
import { FieldRow, Input } from '../ui/Field';
import { AuthColumn, authActionClass, authProseClass } from './AuthColumn';
import { requestSignupLink } from './auth-client';
import { LinkSentActions } from './LinkSentActions';
import { SetupSteps } from './SetupSteps';
import { vaultErrorMessage } from './screen-policy';

/** The worker's sender (`apps/worker-api/src/email.ts`), named so the link can be found in spam. */
const LINK_SENDER = 'no-reply@yozz.app';

/** Sends the sign-up link; resolves to what went wrong, or null once it is on its way. */
const sendSignupLink = async (email: string): Promise<string | null> => {
  try {
    const res = await requestSignupLink(email);
    if (res.error) return res.error.message || 'The login link could not be sent.';
    return null;
  } catch (err) {
    return vaultErrorMessage(err);
  }
};

/**
 * What this screen says about the mail itself, within what ARCHITECTURE.md ("What YOZZ may claim")
 * permits, with the boundary PRODUCT.md requires beside it. What happens to the mail password is
 * said at the password field in Settings, where it is handed over.
 */
const trust = (
  <div className="mb-8">
    <p className={cn('flex items-baseline gap-2.5', authProseClass)}>
      <CheckIcon size={12} weight="bold" aria-hidden className="shrink-0 self-center text-signal" />
      Your mail stays wherever it already lives.
    </p>
    <p className="mt-3 text-2xs text-paper-faint">
      YOZZ doesn't add end-to-end encryption. Your provider keeps the access it already has.
    </p>
  </div>
);

const footer = (
  <p className="text-base text-paper-dim">
    Already have an account?{' '}
    <Link to="/login" search={previous => previous} className="text-paper underline">
      Log in
    </Link>
    .
  </p>
);

export const Welcome = () => {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <AuthColumn
        title="Check your inbox"
        description={`We sent a login link to ${sentTo} from ${LINK_SENDER}. It works for 10 minutes.`}
        progress={<SetupSteps current={1} />}
        footer={footer}
      >
        <LinkSentActions resend={() => sendSignupLink(sentTo)}>
          <LinkButton onClick={() => setSentTo(null)}>Use a different address</LinkButton>
        </LinkSentActions>
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
    <AuthColumn
      title="Create your YOZZ account"
      description="We'll email you a link to confirm it's you."
      progress={<SetupSteps current={1} />}
      footer={footer}
    >
      {trust}
      <form
        className="space-y-4"
        onSubmit={async event => {
          event.preventDefault();
          setIsBusy(true);
          setError(null);
          const failure = await sendSignupLink(email);
          setIsBusy(false);
          if (failure !== null) {
            setError(failure);
            return;
          }
          setSentTo(email);
        }}
      >
        <FieldRow
          label="Your email"
          htmlFor="welcome-email"
          hint="This is your YOZZ login. It can't be changed later."
          hintTone="caution"
        >
          <Input
            id="welcome-email"
            type="email"
            required
            autoFocus
            autoComplete="email"
            aria-describedby="welcome-email-hint"
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
        <Button type="submit" variant="primary" className={authActionClass} disabled={isBusy}>
          {isBusy ? 'Sending…' : 'Continue with email'}
        </Button>
      </form>
      {/* Plain links: the policies are pages of the landing site, not app routes. */}
      <p className="mt-4 text-2xs text-paper-faint">
        By creating an account, you agree to the{' '}
        <a href="/terms" className="text-paper-dim underline">
          Terms
        </a>
        . The{' '}
        <a href="/privacy" className="text-paper-dim underline">
          Privacy policy
        </a>{' '}
        says how your data is handled.
      </p>
    </AuthColumn>
  );
};
