import { useEffect, useState } from 'react';
import { useMail } from '../../store/MailProvider';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { checkPasskeyPrfCapability, type PrfCapability } from '../../vault/passkey-prf';
import type { RecordStore } from '../../vault/record-store';
import { PASSKEY_OFFER, vaultErrorMessage } from '../../vault/screen-policy';
import { useVault } from '../../vault/session';
import { confirmIdentity, needsFreshSession } from '../../vault/unlock';

/** Handed whether the session it started in is still open, checked after each of its awaits. */
export type Action = (isCurrent: () => boolean) => Promise<void>;

/**
 * A change the server refused for want of a fresh session, run again once the person confirms. It
 * keeps the guard of the session it was refused in, and only that session's screen shows it.
 */
type PendingConfirmation<Area extends string> = {
  readonly area: Area;
  readonly action: Action;
  readonly isCurrent: () => boolean;
  readonly store: RecordStore;
};

/**
 * Every change to how a person signs in runs through here: a refused one asks **Confirm it's you**
 * in place, then runs again. Each area keeps its own failure, so it shows where the person acted.
 */
export const useSignInChange = <Area extends string>() => {
  const { session } = useVault();
  const { watchSession } = useMail();

  const [busy, setBusy] = useState<Area | 'confirm' | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Area, string>>>({});
  const [awaiting, setAwaiting] = useState<PendingConfirmation<Area> | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // A sign-in that replaced this session brings another store: the confirmation is not its to answer.
  const pending =
    awaiting !== null && session !== null && awaiting.store === session.store ? awaiting : null;

  const closeConfirmation = () => {
    setAwaiting(null);
    setCurrentPassword('');
    setConfirmError(null);
  };

  /**
   * An action that outlives its session shows nothing in the next one. Resolves to the failure it
   * showed, so a dialog that asked for the action can stay open with it; a refusal for want of a
   * fresh sign-in is not a failure here, it is the question that opens.
   */
  const run = async (
    area: Area,
    action: Action,
    isCurrent = watchSession(),
  ): Promise<string | null> => {
    if (session === null) return null;
    setBusy(area);
    setErrors(previous => ({ ...previous, [area]: undefined }));
    try {
      await action(isCurrent);
      return null;
    } catch (err) {
      if (!isCurrent()) return null;
      if (needsFreshSession(err)) {
        setCurrentPassword('');
        setConfirmError(null);
        setAwaiting({ area, action, isCurrent, store: session.store });
        return null;
      }
      const message = vaultErrorMessage(err);
      setErrors(previous => ({ ...previous, [area]: message }));
      return message;
    } finally {
      setBusy(null);
    }
  };

  /**
   * Under the refused session's guard. A wrong password keeps the dialog open with the reason in
   * it, so this rethrows; once confirmed the change runs again, not awaited, because the dialog
   * closes when this resolves and the retry may refuse again and reopen it.
   */
  const confirmAndRetry = async () => {
    if (pending === null || session === null) return;
    const { area, action, isCurrent } = pending;
    if (!isCurrent()) {
      closeConfirmation();
      return;
    }
    setBusy('confirm');
    setConfirmError(null);
    try {
      await confirmIdentity({ currentSession: session, password: currentPassword });
    } catch (err) {
      if (isCurrent()) setConfirmError(vaultErrorMessage(err));
      throw err;
    } finally {
      setBusy(null);
    }
    if (!isCurrent()) return;
    closeConfirmation();
    void run(area, action, isCurrent);
  };

  const confirmDialog =
    pending === null || session === null ? null : (
      <ConfirmDialog
        open
        onOpenChange={open => {
          if (!open) closeConfirmation();
        }}
        title="Confirm it’s you"
        description="You signed in more than a day ago. Changing how you sign in needs a fresh sign-in, so a session someone else got hold of cannot do it. Your change goes through right after."
        confirmVariant="primary"
        confirmLabel={session.mode === 'passkey' ? 'Confirm with your passkey' : 'Confirm'}
        busyLabel={session.mode === 'passkey' ? 'Waiting for your authenticator…' : 'Confirming…'}
        onConfirm={confirmAndRetry}
      >
        {session.mode === 'password' && (
          <div className="mt-4">
            <FieldRow label="Current password" htmlFor="sign-in-confirm-password">
              <Input
                id="sign-in-confirm-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={currentPassword}
                onChange={event => setCurrentPassword(event.target.value)}
                disabled={busy !== null}
              />
            </FieldRow>
          </div>
        )}
        {confirmError !== null && (
          <p role="alert" className="mt-3 text-base text-danger">
            {confirmError}
          </p>
        )}
      </ConfirmDialog>
    );

  return { busy, errors, run, confirmDialog };
};

/**
 * Whether this browser can offer a passkey for the vault, from a probe. `null` until it answers,
 * and `unknown` still offers one.
 */
export const usePasskeyOffer = (): { canOffer: boolean; note: string | null } | null => {
  const { session } = useVault();
  const [prf, setPrf] = useState<PrfCapability | null>(null);

  useEffect(() => {
    if (session === null) return;
    void (async () => {
      try {
        setPrf(await checkPasskeyPrfCapability());
      } catch {
        setPrf('unknown');
      }
    })();
  }, [session]);

  return prf === null ? null : PASSKEY_OFFER[prf];
};
