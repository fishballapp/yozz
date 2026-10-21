import { ImageIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useChromePref } from '../ui/chrome';
import { reportProblem } from '../ui/Toast';
import { vaultErrorMessage } from '../vault/screen-policy';
import { cachedFrameOf } from './frame-cache';
import { buildMailFrame } from './html';
import { isLoadedByTrust } from './remote-images';
import { useRemoteImages } from './remote-images-context';
import type { SenderCheck } from './thread';

/** What the script inside the frame posts. Anything else on the channel is ignored. */
const FrameMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('yozz:mail-height'), height: z.number().finite().nonnegative() }),
  // A click on a withheld image; the same per-message consent as the button above the frame.
  z.object({ type: z.literal('yozz:load-remote-images') }),
]);

/** A button whose action is a vault write: it says so while it runs, and a refusal is a toast. */
const VaultActionButton = ({
  label,
  busyLabel,
  failure,
  onClick,
  variant = 'ghost',
  className,
}: {
  label: ReactNode;
  busyLabel: string;
  failure: string;
  onClick: () => Promise<void>;
  /** `secondary` where it follows a line of text, which a bare label would read as part of. */
  variant?: 'ghost' | 'secondary';
  className?: string;
}) => {
  const [isBusy, setIsBusy] = useState(false);
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={isBusy}
      onClick={async () => {
        setIsBusy(true);
        try {
          await onClick();
        } catch (error) {
          reportProblem(failure, vaultErrorMessage(error));
        } finally {
          setIsBusy(false);
        }
      }}
      className={cn('h-11 max-w-full lg:h-7', className)}
    >
      {isBusy ? busyLabel : label}
    </Button>
  );
};

/** Why YOZZ cannot vouch for an unverified sender, said before trusting one anyway. */
const warningOf = (check: Exclude<SenderCheck, { status: 'verified' }>, address: string) => {
  const cost = 'Fakes from this address would load images too.';
  if (check.status === 'unchecked') {
    return {
      title: `Always load images from ${address}?`,
      description: `YOZZ can't verify senders on ${check.imapHost}. ${cost}`,
      confirmVariant: 'primary',
    } as const;
  }
  return {
    title: 'This message may be forged',
    description: `It failed sender verification. ${cost}`,
    // The safer answer is Cancel, so Always load is no louder than it.
    confirmVariant: 'ghost',
  } as const;
};

/**
 * "Always from <address>": one click for a sender the provider verified, which trusts only their
 * verified mail; for any other, a warning first, and the trust covers all mail showing that From.
 */
const AlwaysFromButton = ({
  address,
  check,
  variant,
  onTrusted,
}: {
  address: string;
  check: SenderCheck;
  variant?: 'ghost' | 'secondary';
  onTrusted: () => void;
}) => {
  const remoteImages = useRemoteImages();
  // Why the last save in the warning failed, shown in the sheet, which stays open to retry.
  const [error, setError] = useState<string | null>(null);
  const label = <span className="truncate">Always from {address}</span>;
  if (check.status === 'verified') {
    return (
      <VaultActionButton
        label={label}
        busyLabel="Saving…"
        failure="Sender not saved"
        variant={variant}
        onClick={async () => {
          await remoteImages.trust({ address, isVerifiedOnly: true });
          onTrusted();
        }}
      />
    );
  }
  const warning = warningOf(check, address);
  return (
    <ConfirmDialog
      trigger={
        <Button
          variant={variant ?? 'ghost'}
          size="sm"
          onClick={() => setError(null)}
          className="h-11 max-w-full lg:h-7"
        >
          {label}
        </Button>
      }
      title={warning.title}
      description={warning.description}
      confirmLabel="Always load"
      confirmVariant={warning.confirmVariant}
      busyLabel="Saving…"
      onConfirm={async () => {
        setError(null);
        try {
          await remoteImages.trust({ address, isVerifiedOnly: false });
        } catch (failure) {
          setError(`Sender not saved. ${vaultErrorMessage(failure)}`);
          throw failure;
        }
        onTrusted();
      }}
    >
      {error !== null && (
        <p role="alert" className="mt-3 text-base text-danger">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
};

/**
 * The frame cannot be measured from outside, so a nonce'd script posts its own height; only
 * messages from this frame's window are trusted, and the height is capped. Containment is
 * documented on `threads/html.ts`.
 *
 * Remote images load when this message was consented to before, on any device (the pixel has
 * fired and the address has leaked, so asking again buys nothing), or when its shown From is
 * trusted and, for a trust given from a verified message, `senderCheck` says this one is verified.
 */
export const HtmlBody = ({
  html,
  messageId,
  fromName,
  fromAddress,
  senderCheck,
  inlineImagesTruncated,
  fallback,
}: {
  html: string;
  messageId: string;
  fromName: string;
  fromAddress: string;
  /** Undefined offers no "Always from": nothing is known about this From. */
  senderCheck: SenderCheck | undefined;
  inlineImagesTruncated: boolean;
  fallback: ReactNode;
}) => {
  const remoteImages = useRemoteImages();
  // From props alone, so a component React reuses for the next message holds nothing of this one.
  const consent = { messageId, sender: fromAddress };
  const trustedSender = remoteImages.trustOf(fromAddress);
  const isTrustedSender = isLoadedByTrust(trustedSender, senderCheck);
  const isRemoteAllowed = remoteImages.isConsented(consent) || isTrustedSender;
  const allowRemoteImages = () => remoteImages.consent(consent);
  // A withheld picture looks like a picture, so the first click on one explains what loading costs.
  const [asksBeforeImageClick, setAsksBeforeImageClick] = useChromePref(
    'yozz:ask-before-remote-images',
    true,
    raw => raw !== 'false',
  );
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const isAsking = askingFor === messageId;
  const [skipNextTime, setSkipNextTime] = useState(false);
  const [measurement, setMeasurement] = useState({ html, height: 160 });
  const height = measurement.html === html ? measurement.height : 160;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Read by the frame's listener, which is not re-attached for every change of the consent lists.
  const allowRemoteImagesRef = useRef(allowRemoteImages);
  allowRemoteImagesRef.current = allowRemoteImages;
  const frame = useMemo(() => {
    try {
      // The cache is keyed by bytes alone, so it holds only the withheld frame.
      return isRemoteAllowed
        ? buildMailFrame(html, { allowRemoteImages: true })
        : cachedFrameOf(html, () => buildMailFrame(html, { allowRemoteImages: false }));
    } catch {
      return null;
    }
  }, [html, isRemoteAllowed]);
  const hasRemoteImages = frame?.hasRemoteImages ?? false;
  const remoteImagesTruncated = frame?.remoteImagesTruncated ?? false;
  const srcdoc = frame?.srcdoc;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = FrameMessageSchema.safeParse(event.data);
      if (!message.success) return;
      if (message.data.type === 'yozz:load-remote-images') {
        if (asksBeforeImageClick) {
          setAskingFor(messageId);
        } else {
          allowRemoteImagesRef.current();
        }
        return;
      }
      const next = Math.min(Math.max(Math.ceil(message.data.height), 40), 20000);
      setMeasurement(current =>
        current.html === html && current.height === next ? current : { html, height: next },
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html, messageId, asksBeforeImageClick]);

  if (srcdoc === undefined) return fallback;

  return (
    <div className="space-y-2">
      {/* Nothing is offered until the remembered answers are read, or the bar flashes on a
          message about to load by itself. */}
      {remoteImages.isReady && hasRemoteImages && !isRemoteAllowed && (
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 lg:min-h-7">
          {/* Pulled out by its padding as a pair, so whichever button starts a line on a phone
              lines up with the text under it. */}
          <div className="-ml-2.5 flex min-w-0 flex-wrap items-center">
            <Button variant="ghost" size="sm" onClick={allowRemoteImages} className="h-11 lg:h-7">
              <ImageIcon size={13} />
              Load remote images
            </Button>
            {senderCheck !== undefined && (
              <AlwaysFromButton
                address={fromAddress}
                check={senderCheck}
                onTrusted={allowRemoteImages}
              />
            )}
          </div>
          <span className="font-mono text-2xs text-paper-faint">
            The sender may learn you opened this message.
          </span>
        </div>
      )}
      {/* Loaded by hand, so "always" is still on offer, from where the bar was. */}
      {remoteImages.isReady &&
        hasRemoteImages &&
        isRemoteAllowed &&
        !isTrustedSender &&
        senderCheck !== undefined && (
          // The bar's order, the offer before the note, so a phone wraps the note and not the offer.
          <div className="flex min-h-11 flex-wrap items-center gap-x-3 lg:min-h-7">
            <AlwaysFromButton
              address={fromAddress}
              check={senderCheck}
              variant="secondary"
              onTrusted={allowRemoteImages}
            />
            <span className="font-mono text-2xs text-paper-faint">Just this message.</span>
          </div>
        )}
      {hasRemoteImages && isTrustedSender && (
        // One line, so Stop never sits on a line of its own.
        <div className="flex min-h-11 items-center gap-x-3 lg:min-h-7">
          {/* Only the address shortens: the rule after it is the point of the line. */}
          <span className="flex min-w-0 font-mono text-2xs whitespace-pre text-paper-faint">
            <span className="shrink-0">Images from </span>
            <span className="truncate">{fromAddress}</span>
            <span className="shrink-0">
              {trustedSender?.isVerifiedOnly === false
                ? ' always load, verified or not.'
                : ' always load.'}
            </span>
          </span>
          <VaultActionButton
            label="Stop"
            busyLabel="Stopping…"
            variant="secondary"
            failure="Sender not removed"
            onClick={async () => {
              await remoteImages.forget(fromAddress);
              // This message too, so its images block in place; others keep their own consent.
              // The sender is gone by now, so a refusal here is reported as what it is.
              try {
                await remoteImages.unconsent(consent);
              } catch (error) {
                reportProblem(
                  'Sender removed',
                  `This message's images may load again after a reload. ${vaultErrorMessage(error)}`,
                );
              }
            }}
          />
        </div>
      )}
      {remoteImagesTruncated && isRemoteAllowed && (
        <p className="font-mono text-2xs text-paper-faint">Some remote images were blocked.</p>
      )}
      {inlineImagesTruncated && (
        <p className="font-mono text-2xs text-paper-faint">Some inline images were blocked.</p>
      )}
      <ConfirmDialog
        open={isAsking}
        onOpenChange={open => setAskingFor(open ? messageId : null)}
        title="Show remote images?"
        description="Images load from the sender's servers, so they may see you opened this. Just this message."
        confirmLabel="Show images"
        // Not a deletion: this one wants a decision.
        confirmVariant="primary"
        busyLabel="Showing…"
        onConfirm={async () => {
          if (skipNextTime) setAsksBeforeImageClick(false);
          allowRemoteImages();
        }}
      >
        <label className="mt-4 flex items-center gap-2 text-base text-paper">
          <input
            type="checkbox"
            checked={skipNextTime}
            onChange={event => setSkipNextTime(event.target.checked)}
            className="size-4 accent-signal"
          />
          Don't ask again when I click an image
        </label>
      </ConfirmDialog>
      <iframe
        key={isRemoteAllowed ? 'remote' : 'blocked'}
        ref={frameRef}
        title={`Message from ${fromName}`}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        className="w-full border-0"
        style={{ height }}
      />
    </div>
  );
};
