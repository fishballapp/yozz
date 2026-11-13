import { type ReactNode, useEffect, useState } from 'react';
import { LinkButton } from '../ui/Button';

export const RESEND_COOLDOWN_SECONDS = 30;

/**
 * The actions under "Check your inbox": send the same link again, no sooner than 30 seconds after
 * the last one so a slow inbox is not answered with a pile of links, beside the screen's own way
 * out. `resend` resolves to what went wrong, or null once the link is sent.
 */
export const LinkSentActions = ({
  resend,
  children,
}: {
  resend: () => Promise<string | null>;
  children: ReactNode;
}) => {
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);
  const [isSending, setIsSending] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly error: string | null } | null>(null);

  useEffect(() => {
    if (secondsLeft === 0) return;
    const tick = setTimeout(() => setSecondsLeft(previous => previous - 1), 1000);
    return () => clearTimeout(tick);
  }, [secondsLeft]);

  const label = (() => {
    if (isSending) return 'Sending…';
    if (secondsLeft > 0) return `Resend link in ${secondsLeft}s`;
    return 'Resend link';
  })();

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <LinkButton
          disabled={isSending || secondsLeft > 0}
          className="tabular-nums"
          onClick={async () => {
            setIsSending(true);
            setOutcome(null);
            const error = await resend();
            setIsSending(false);
            setOutcome({ error });
            if (error === null) setSecondsLeft(RESEND_COOLDOWN_SECONDS);
          }}
        >
          {label}
        </LinkButton>
        {children}
      </div>
      {outcome?.error === null && (
        <p role="status" className="mt-3 text-base text-paper-dim">
          Sent again.
        </p>
      )}
      {outcome !== null && outcome.error !== null && (
        <p role="alert" className="mt-3 text-base text-danger">
          {outcome.error}
        </p>
      )}
    </div>
  );
};
