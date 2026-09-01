import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useMail } from '../state/mail';
import { isJudgeAddress } from './domain';

/**
 * HACKATHON ONLY: delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 *
 * A judge's mailbox is real mail, so the banner says what it is and hands them Reset rather
 * than resetting on a timer. Loud on purpose: the one place --signal-well is spent outside the
 * send-only chip.
 */

export const JudgeBanner = () => {
  const { ownedAddresses, resetDemoInbox } = useMail();
  const [message, setMessage] = useState<string | null>(null);

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
          Reset inbox wipes everything and restores the 15 demo messages, so a second run starts
          exactly where the first did.
        </p>
      </div>
      <span aria-live="polite">{message}</span>
      <ConfirmDialog
        title="Reset this mailbox?"
        description="Everything in it — including mail you sent or received yourself, and any drafts — is deleted, and the 15 demo messages come back in their original folders and read states."
        confirmLabel="Reset inbox"
        busyLabel="Resetting…"
        trigger={<Button variant="secondary" />}
        triggerLabel="Reset inbox"
        onConfirm={async () => {
          // The live region carries the outcome only.
          setMessage(null);
          await resetDemoInbox()
            .then(setMessage)
            // A throw must not leave the run with nothing to show.
            .catch(() => setMessage('The mailbox could not be reached; try again in a moment.'));
        }}
      />
    </div>
  );
};
