import { TrashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { PageSection } from '../ui/PageColumn';
import { forgetPin, listPins, type PinnedPeer } from './peer-store';

/**
 * Every mail host this device has pinned, and the one way to accept a new key: forget the old
 * one, so the next connection learns whatever key the host proves it holds. Deliberately a
 * step away from the failure rather than a button on it — a pin alarm is meant to be read.
 */
export const ServerKeysSection = () => {
  const [pins, setPins] = useState<readonly PinnedPeer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const run = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true);
    try {
      await action();
      setPins(await listPins());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsBusy(false);
    }
  }, []);
  useEffect(() => {
    void run(async () => {});
  }, [run]);

  return (
    <PageSection
      label="Server keys"
      note="The public key each mail server proved it held the first time this device connected. A later connection presenting a different key is refused until you forget the pinned one here. A routine certificate renewal keeps the key; a change means the server was re-keyed, or something sits between you and it."
    >
      {error !== null && (
        <p role="alert" className="text-base text-danger">
          {error}
        </p>
      )}
      {pins !== null && pins.length === 0 && (
        <p className="text-base text-paper-dim">No server keys pinned yet.</p>
      )}
      {pins !== null && pins.length > 0 && (
        <ul>
          {pins.map(({ peer, pin }) => (
            <li key={peer} className="flex items-center gap-3 border-b border-rule-soft py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-paper">{peer}</span>
                <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
                  sha256/{pin}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 size-11 lg:size-7"
                disabled={isBusy}
                onClick={() => void run(() => forgetPin(peer))}
                aria-label={`Forget the pinned key for ${peer}`}
              >
                <TrashIcon size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PageSection>
  );
};
