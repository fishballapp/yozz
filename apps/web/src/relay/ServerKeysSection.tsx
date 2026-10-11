import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type AddressRecord, isInbound } from '../addresses/record';
import { useMail } from '../store/MailProvider';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PageSection } from '../ui/PageSection';
import { forgetPin, listPins, type PinnedPeer } from './peer-store';

/** The hosts an address reads and sends through. Their keys show on that address's own page. */
const serversOf = (record: AddressRecord): readonly string[] =>
  isInbound(record) ? [record.imap.host, record.smtp.host] : [record.smtp.host];

/** A pin is keyed `host:port`; the host is everything before the last colon. */
const hostOf = (peer: string): string => peer.slice(0, peer.lastIndexOf(':'));

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The pinned keys of servers no address of yours uses, so they belong to no screen but this one.
 * With none it renders `empty`, or nothing when no `empty` is given. Forgetting one is a question,
 * so it asks first.
 */
export const ServerKeysSection = ({ empty }: { empty?: ReactNode }) => {
  const { identities } = useMail();
  const [pins, setPins] = useState<readonly PinnedPeer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<PinnedPeer | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPins(await listPins());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const addressServers = new Set(identities.flatMap(serversOf));
  const otherPins = (pins ?? []).filter(({ peer }) => !addressServers.has(hostOf(peer)));

  // Forgetting goes through here so a refusal keeps the question open with its reason in it.
  const forget = async (peer: string) => {
    try {
      await forgetPin(peer);
    } catch (cause) {
      setForgetError(messageOf(cause));
      throw cause;
    }
    setForgetting(null);
    setForgetError(null);
    await load();
  };

  if (otherPins.length === 0 && error === null && empty === undefined) return null;

  return (
    <PageSection
      label="Server keys"
      note="Servers no address of yours uses, pinned the first time this device connected to them. A changed key is refused until you forget the old one."
      error={error}
    >
      {otherPins.length === 0 && error === null && (
        <p className="text-base text-paper-dim">{empty}</p>
      )}
      {otherPins.length > 0 && (
        <ul>
          {otherPins.map(({ peer, pin }) => (
            <li key={peer} className="flex items-center gap-3 border-b border-rule-soft py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-paper">{peer}</span>
                <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
                  sha256/{pin}
                </span>
              </span>
              <Button
                variant="ghost"
                className="-mr-2.5 shrink-0"
                onClick={() => {
                  setForgetError(null);
                  setForgetting({ peer, pin });
                }}
                aria-label={`Forget key for ${peer}`}
              >
                Forget key
              </Button>
            </li>
          ))}
        </ul>
      )}
      {forgetting !== null && (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) setForgetting(null);
          }}
          title={`Forget the key for ${forgetting.peer}?`}
          description="The next connection to this server accepts whichever key it shows and pins that one. Forget a key only when you know the server was re-keyed."
          confirmLabel="Forget key"
          busyLabel="Forgetting…"
          onConfirm={() => forget(forgetting.peer)}
        >
          {forgetError !== null && (
            <p role="alert" className="mt-3 text-base text-danger">
              {forgetError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </PageSection>
  );
};
