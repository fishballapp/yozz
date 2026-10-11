import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { forgetPin, loadPin, peerKey } from './peer-store';

/**
 * A mail server as a line of a `<dl>`, with the key this device pinned for it under its address.
 * Forgetting is how a new key is accepted, so it is a question first: a pin is the one alarm the
 * mechanism has (DECISIONS.md, "Pins and sessions are per device").
 */
export const ServerRow = ({ term, host, port }: { term: string; host: string; port: number }) => {
  const peer = peerKey(host, port);
  /** `undefined` until the device has answered. */
  const [pin, setPin] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPin(undefined);
    setError(null);
    loadPin(peer).then(
      found => {
        if (!cancelled) setPin(found);
      },
      cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [peer]);

  return (
    <div className="flex items-baseline gap-4 border-b border-rule-soft py-2.5">
      <dt className="label-rule w-24 shrink-0">{term}</dt>
      <dd className="min-w-0 flex-1">
        <span className="block truncate font-mono text-2xs text-paper">{peer}</span>
        <span className="mt-1 flex items-center justify-between gap-3 text-2xs text-paper-faint">
          {pin === null && <span>No key yet; pinned on first connection</span>}
          {typeof pin === 'string' && (
            <>
              <span title={`sha256/${pin}`} className="min-w-0 truncate font-mono">
                Key sha256/{pin.slice(0, 12)}…
              </span>
              <ConfirmDialog
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-my-2 -mr-2.5 h-11 lg:h-7"
                    aria-label={`Forget key for ${peer}`}
                  />
                }
                triggerLabel="Forget key"
                title={`Forget the key for ${peer}?`}
                description="The next connection trusts whatever key the server proves. Do it only if you expect the server was re-keyed."
                confirmLabel="Forget key"
                busyLabel="Forgetting…"
                onConfirm={async () => {
                  try {
                    await forgetPin(peer);
                    setPin(null);
                    setError(null);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              />
            </>
          )}
        </span>
        {error !== null && (
          <span role="alert" className="mt-1 block text-2xs text-danger">
            {error}
          </span>
        )}
      </dd>
    </div>
  );
};
