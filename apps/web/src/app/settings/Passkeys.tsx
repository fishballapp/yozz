import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { PASSKEY_NAME_MAX_LENGTH } from '@yozz.app/vault-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { PageSection } from '../../ui/PageSection';
import { fullDate } from '../../ui/time';
import { normalizePasskeyName } from '../../vault/passkey-name';
import { vaultErrorMessage } from '../../vault/screen-policy';
import { useVault } from '../../vault/session';
import {
  type AccountPasskey,
  addPasskeyToSession,
  listPasskeys,
  removePasskey,
  renamePasskey,
  type UnlockedVaultSession,
} from '../../vault/unlock';
import type { Action } from './SignInChange';

const labelOf = ({ name }: AccountPasskey) => name ?? 'Passkey';

/**
 * This account's passkeys, each with the day it was added, and the one action each has. The list and
 * the open question belong to the session that loaded them: a pane that outlives its session (a
 * sign-in as someone else in this tab) shows neither.
 */
export const PasskeysSection = ({
  session,
  isBusy,
  error,
  run,
}: {
  session: UnlockedVaultSession;
  isBusy: boolean;
  error: string | undefined;
  run: (area: 'passkeys', action: Action) => Promise<string | null>;
}) => {
  const { setSession } = useVault();
  const { store, userId } = session;
  const [loaded, setLoaded] = useState<{
    store: RecordStore;
    passkeys: readonly AccountPasskey[];
  } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [isAdded, setIsAdded] = useState(false);
  const [naming, setNaming] = useState<{
    store: RecordStore;
    passkeyId: string;
    /** What the row carries now: null for a passkey that has no name. */
    stored: string | null;
    isNew: boolean;
    typed: string;
  } | null>(null);
  const [removal, setRemoval] = useState<{ store: RecordStore; passkey: AccountPasskey } | null>(
    null,
  );

  const storeRef = useRef(store);
  storeRef.current = store;
  const reload = useCallback(async () => {
    try {
      const passkeys = await listPasskeys(userId);
      if (storeRef.current !== store) return;
      setLoaded({ store, passkeys });
      setListError(null);
    } catch (cause) {
      if (storeRef.current === store) setListError(vaultErrorMessage(cause));
    }
  }, [userId, store]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** The server's passkey list is part of what a reload checks the saved keys against. */
  const keepThisDeviceSignedIn = () => setSession({ ...session });

  const passkeys = loaded?.store === store ? loaded.passkeys : null;
  const openRemoval = removal?.store === store ? removal.passkey : null;
  const openNaming = naming?.store === store ? naming : null;

  return (
    <PageSection
      label="Passkeys"
      note="Each passkey you add can sign you in on its own. Add one from a device before you need it."
      error={openRemoval !== null || openNaming !== null ? null : (error ?? listError)}
    >
      {passkeys !== null && (
        <ul className="mb-4">
          {passkeys.map(passkey => (
            <li
              key={passkey.credentialId}
              className="flex items-center gap-3 border-b border-rule-soft py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-paper">{labelOf(passkey)}</span>
                <span className="mt-0.5 block font-mono text-2xs text-paper-faint">
                  Added {fullDate(passkey.addedAt)}
                </span>
              </span>
              <span className="-mr-2.5 flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  disabled={isBusy}
                  aria-label={`Rename ${labelOf(passkey)} added ${fullDate(passkey.addedAt)}`}
                  onClick={() =>
                    setNaming({
                      store,
                      passkeyId: passkey.id,
                      stored: passkey.name,
                      isNew: false,
                      typed: passkey.name ?? '',
                    })
                  }
                >
                  Rename
                </Button>
                {passkeys.length > 1 && (
                  <Button
                    variant="ghost"
                    disabled={isBusy}
                    aria-label={`Remove ${labelOf(passkey)} added ${fullDate(passkey.addedAt)}`}
                    onClick={() => setRemoval({ store, passkey })}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {passkeys?.length === 1 && (
        <p className="-mt-1 mb-4 text-2xs text-paper-faint">
          This is your only passkey. Add another before you can remove it.
        </p>
      )}
      <div className="space-y-3">
        <Button
          variant="secondary"
          disabled={isBusy}
          onClick={() => {
            setIsAdded(false);
            void run('passkeys', async isCurrent => {
              const added = await addPasskeyToSession({ currentSession: session, isCurrent });
              if (added.outcome !== 'added') return;
              setIsAdded(true);
              keepThisDeviceSignedIn();
              // It already carries this browser's name; the dialog offers a better one.
              setNaming({
                store,
                passkeyId: added.passkeyId,
                stored: added.name,
                isNew: true,
                typed: added.name,
              });
              await reload();
            });
          }}
        >
          {isBusy ? 'Waiting for your authenticator…' : 'Add passkey'}
        </Button>
        {isAdded && (
          <p role="status" className="text-base text-paper-dim">
            Added. That passkey can now sign you in.
          </p>
        )}
      </div>
      {openNaming !== null && (
        <ConfirmDialog
          open
          onOpenChange={isOpen => {
            if (!isOpen) setNaming(null);
          }}
          title={openNaming.isNew ? 'Name this passkey' : 'Rename passkey'}
          description={
            openNaming.isNew
              ? 'Pick a name you will recognise in this list. Skip keeps the one it has.'
              : 'Pick a name you will recognise in this list.'
          }
          confirmLabel="Save"
          cancelLabel={openNaming.isNew ? 'Skip' : 'Cancel'}
          confirmVariant="primary"
          busyLabel="Saving…"
          isConfirmEnabled={openNaming.isNew || normalizePasskeyName(openNaming.typed) !== ''}
          onConfirm={async () => {
            // A new passkey's blank name is the one it was offered; a rename of one that had none
            // has no such name to fall back to, which is why its Save waits for a letter. It always
            // writes: the automatic name may never have been stored, and Save is what makes sure.
            const name = normalizePasskeyName(openNaming.typed) || openNaming.stored;
            if (name === null) return;
            const failure = await run('passkeys', async isCurrent => {
              await renamePasskey({ userId, passkeyId: openNaming.passkeyId, name });
              if (isCurrent()) await reload();
            });
            if (failure !== null) throw new Error(failure);
          }}
        >
          <div className="mt-4">
            <FieldRow label="Name" htmlFor="passkey-name">
              <Input
                id="passkey-name"
                autoComplete="off"
                autoFocus
                maxLength={PASSKEY_NAME_MAX_LENGTH}
                value={openNaming.typed}
                onFocus={event => event.currentTarget.select()}
                onChange={event => setNaming({ ...openNaming, typed: event.target.value })}
              />
            </FieldRow>
          </div>
          {error !== undefined && (
            <p role="alert" className="mt-3 text-base text-danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
      {openRemoval !== null && (
        <ConfirmDialog
          open
          onOpenChange={isOpen => {
            if (!isOpen) setRemoval(null);
          }}
          title="Remove this passkey?"
          description={`The device or password manager holding the passkey added ${fullDate(openRemoval.addedAt)} can no longer sign in to ${session.email}, and every other device is signed out. Your other passkeys still work.`}
          confirmLabel="Remove passkey"
          busyLabel="Removing…"
          onConfirm={async () => {
            // A dialog that closes on a refusal would hide it; one asking for a fresh sign-in closes.
            const failure = await run('passkeys', async isCurrent => {
              try {
                await removePasskey({ userId, credentialId: openRemoval.credentialId });
              } finally {
                // Whatever the answer, the list may no longer be what it was (another device).
                if (isCurrent()) await reload();
              }
              if (isCurrent()) keepThisDeviceSignedIn();
            });
            if (failure !== null) throw new Error(failure);
          }}
        >
          {error !== undefined && (
            <p role="alert" className="mt-3 text-base text-danger">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </PageSection>
  );
};
