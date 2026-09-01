import { ImageIcon } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useChromePref } from '../lib/chrome';
import { buildMailFrame } from '../mail/html';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';

/** What the script inside the frame posts. Anything else on the channel is ignored. */
const FrameMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('yozz:mail-height'), height: z.number().finite().nonnegative() }),
  // A click on a withheld image; the same per-message consent as the button above the frame.
  z.object({ type: z.literal('yozz:load-remote-images') }),
]);

/**
 * A received HTML body, rendered inside a sandboxed iframe. The containment design — sanitizer,
 * CSP, sandbox, and why images are off until asked — is documented on `mail/html.ts`.
 *
 * The frame cannot be measured from outside (opaque origin), so a nonce'd script inside it posts
 * its own height and the iframe follows; the listener trusts only messages whose source IS this
 * frame's window. Height is capped: a message may honestly be enormous, but it does not get to
 * make the reader arbitrarily tall faster than you can scroll away.
 */
export const HtmlBody = ({
  html,
  fromName,
  inlineImagesTruncated,
  fallback,
}: {
  html: string;
  fromName: string;
  inlineImagesTruncated: boolean;
  fallback: ReactNode;
}) => {
  // Consent belongs to these exact bytes, not to this component instance: when selection changes
  // React may reuse the component, and the next sender must not inherit the previous sender's opt-in.
  const [remoteAllowedFor, setRemoteAllowedFor] = useState<string | null>(null);
  const isRemoteAllowed = remoteAllowedFor === html;
  // A withheld picture looks like a picture, not a control, so the first click on one explains
  // what loading costs. The button above the frame carries that line itself and asks nothing.
  const [asksBeforeImageClick, setAsksBeforeImageClick] = useChromePref(
    'yozz:ask-before-remote-images',
    true,
    raw => raw !== 'false',
  );
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const isAsking = askingFor === html;
  const [skipNextTime, setSkipNextTime] = useState(false);
  const [measurement, setMeasurement] = useState({ html, height: 160 });
  const height = measurement.html === html ? measurement.height : 160;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frame = useMemo(() => {
    try {
      return buildMailFrame(html, { allowRemoteImages: isRemoteAllowed });
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
        if (asksBeforeImageClick) setAskingFor(html);
        else setRemoteAllowedFor(html);
        return;
      }
      const next = Math.min(Math.max(Math.ceil(message.data.height), 40), 20000);
      setMeasurement(current =>
        current.html === html && current.height === next ? current : { html, height: next },
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html, asksBeforeImageClick]);

  if (srcdoc === undefined) return fallback;

  return (
    <div className="space-y-2">
      {hasRemoteImages && !isRemoteAllowed && (
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 lg:min-h-7">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRemoteAllowedFor(html)}
            className="-ml-2.5 h-11 lg:h-7"
          >
            <ImageIcon size={13} />
            Load remote images
          </Button>
          <span className="font-mono text-2xs text-paper-faint">
            The sender may learn you opened this message.
          </span>
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
        onOpenChange={open => setAskingFor(open ? html : null)}
        title="Show remote images?"
        description="The pictures in this message load from the sender's servers, so the sender may learn you opened it. This applies to this message only."
        confirmLabel="Show images"
        // Not a deletion: this one wants a decision, so it takes the primary action's colour.
        confirmVariant="primary"
        busyLabel="Showing…"
        onConfirm={async () => {
          if (skipNextTime) setAsksBeforeImageClick(false);
          setRemoteAllowedFor(html);
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
