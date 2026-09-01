import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { useMail } from '../state/mail';
import { isJudgeAddress } from './domain';

/**
 * HACKATHON ONLY — delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 * Tracked as item 0 of HANDOFF.md's Next.
 *
 * A judge's mailbox is real mail on a real server, so what they do to it stays done — and the next
 * judge inherits an inbox somebody already tidied. Rather than resetting it on a timer behind their
 * back, the banner says what the mailbox is and hands them the button.
 *
 * It is LOUD on purpose, and it is the one place --signal-well is spent outside the send-only chip.
 * The restraint the token system asks for is about the product; this bar has to be read by someone
 * who has ninety seconds and has never seen yozz, so it takes the accent rather than the quiet
 * status-strip treatment every other bar in this app gets.
 *
 * The copy answers three questions in the order a judge asks them: what this is, whether it is
 * real, and what Reset does to their mail. An earlier draft spent its first two sentences
 * explaining the BANNER, which is the one thing nobody signed in to read.
 */

export const JudgeBanner = () => {
  const { ownedAddresses, resetDemoInbox } = useMail();
  const [message, setMessage] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  if (!ownedAddresses.some(isJudgeAddress)) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-signal border-b bg-signal-well px-4 py-3 text-base text-paper-dim">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-mono text-signal text-2xs uppercase tracking-wide">
          WebMCP Challenge demo
        </p>
        <p>
          <span className="text-paper">This is your own demo mailbox in yozz.</span> It sends and
          receives real email. We'll delete it after judging.
        </p>
        <p>
          Reset inbox restores the 15 demo messages to their original folders and read states. Your
          own mail stays put.
        </p>
      </div>
      <span aria-live="polite">{message}</span>
      <Button
        variant="secondary"
        disabled={isResetting}
        onClick={() => {
          setIsResetting(true);
          // The button's own label is the in-progress state. The live region carries the OUTCOME
          // only: when both said "Resetting…" the word was on screen twice, side by side.
          setMessage(null);
          void resetDemoInbox()
            .then(setMessage)
            // Without this a throw leaves the run with nothing to show for it, which is the one
            // thing worse than an error after a three-minute wait.
            .catch(() => setMessage('The mailbox could not be reached; try again in a moment.'))
            .finally(() => setIsResetting(false));
        }}
      >
        {isResetting ? 'Resetting…' : 'Reset inbox'}
      </Button>
    </div>
  );
};
