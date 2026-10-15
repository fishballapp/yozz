import { useState } from 'react';
import { useRemoteImages } from '../../threads/remote-images-context';
import { Button } from '../../ui/Button';
import { PageSection } from '../../ui/PageSection';
import { fullDate } from '../../ui/time';
import { vaultErrorMessage } from '../../vault/screen-policy';
import { SettingsPane } from './SettingsPane';

/**
 * Who you load pictures from without asking. Added from a message ("Always from …"), so this pane
 * only lists and removes; a removal is undone from the next message the same way.
 */
export const RemoteImages = () => {
  const { isReady, trustedSenders, forget } = useRemoteImages();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SettingsPane title="Remote images">
      <PageSection
        label="Always load from"
        note="Pictures in mail from these senders load without asking, but only when your provider confirms the message really came from that address. Add a sender from one of their messages."
        error={error}
      >
        {isReady && trustedSenders.length === 0 && (
          <p className="text-base text-paper-faint">No senders yet.</p>
        )}
        <ul>
          {trustedSenders.map(sender => (
            <li
              key={sender.address}
              className="flex items-center gap-3 border-b border-rule-soft py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-paper">{sender.address}</span>
                <span className="mt-0.5 block font-mono text-2xs text-paper-faint">
                  Added {fullDate(sender.addedAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                disabled={removing !== null}
                aria-label={`Stop loading images from ${sender.address}`}
                className="-mr-2.5"
                onClick={async () => {
                  setRemoving(sender.address);
                  setError(null);
                  try {
                    await forget(sender.address);
                  } catch (failure) {
                    setError(vaultErrorMessage(failure));
                  } finally {
                    setRemoving(null);
                  }
                }}
              >
                {removing === sender.address ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      </PageSection>
    </SettingsPane>
  );
};
