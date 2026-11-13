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
 * Why it is safe to hand this product a mail password, within what ARCHITECTURE.md ("What YOZZ may
 * claim") permits, with the boundary it requires beside any such claim. The password does leave the
 * device (to the mail server, inside the browser's own TLS), so the lines say where it is encrypted
 * and who holds the key, not that it stays put.
 */
const TRUST_LINES = [
  'Your mail stays wherever it already lives.',
  'Your mail passwords are encrypted on your device before YOZZ stores them.',
  "Only you hold the key, so we can't read them.",
] as const;

const trust = (
  <div className="mb-8">
    <ul className="space-y-1.5">
      {TRUST_LINES.map(line => (
        <li key={line} className={cn('flex items-baseline gap-2.5', authProseClass)}>
          <CheckIcon
            size={12}
            weight="bold"
            aria-hidden
            className="shrink-0 self-center text-signal"
          />
          {line}
        </li>
      ))}
    </ul>
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
      description="Read and send from every address you own, in one inbox. We'll email you a link to confirm it's you."
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
