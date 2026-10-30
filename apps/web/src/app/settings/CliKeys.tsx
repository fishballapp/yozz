import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { PageSection } from '../../ui/PageSection';
import { fullDate } from '../../ui/time';
import { type AccountCliKey, listCliKeys, revokeCliKey } from '../../vault/cli-keys';
import { vaultErrorMessage } from '../../vault/screen-policy';
import type { UnlockedVaultSession } from '../../vault/unlock';
import type { Action } from './SignInChange';

/** Every string in this section, so a copy pass rewrites them in one place. */
const COPY = {
  label: 'CLI keys',
  note: 'Each key lets the yozz command on one computer open your mail. Revoke one you no longer use.',
  emptyLead: 'No CLI keys yet. Run ',
  emptyCommand: 'yozz login',
  emptyTail: ' in a terminal to add one.',
  added: (at: number) => `Added ${fullDate(at)}`,
  lastUsed: (at: number | null) => (at === null ? 'Never used' : `Last used ${fullDate(at)}`),
  revoke: 'Revoke',
  revokeLabel: ({ name, pairingCode }: AccountCliKey) => `Revoke ${name} (${pairingCode})`,
  dialogTitle: 'Revoke this key?',
  dialogDescription: ({ name, pairingCode }: AccountCliKey) =>
    `yozz on ${name} (${pairingCode}) can no longer open your mail. What it has already read stays on that computer.`,
  confirm: 'Revoke key',
  busy: 'Revoking…',
  freshSignIn:
    'You signed in more than a day ago. Revoking a CLI key needs a fresh sign-in, so a session someone else got hold of cannot do it. The key is revoked right after.',
} as const;

/** What **Confirm it's you** says when a revocation asked for it. */
export const CLI_KEY_FRESH_SIGN_IN = COPY.freshSignIn;

/**
 * This account's CLI keys, each with the code its terminal showed, and Revoke. The list and the open
 * question belong to the session that loaded them, as the passkeys' do.
 */
export const CliKeysSection = ({
  session,
  isBusy,
  error,
  run,
}: {
  session: UnlockedVaultSession;
  isBusy: boolean;
  error: string | undefined;
  run: (area: 'cliKeys', action: Action) => Promise<string | null>;
}) => {
  const { store, userId } = session;
  const [loaded, setLoaded] = useState<{
    store: RecordStore;
    keys: readonly AccountCliKey[];
  } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [revocation, setRevocation] = useState<{ store: RecordStore; key: AccountCliKey } | null>(
    null,
  );

  const storeRef = useRef(store);
  storeRef.current = store;
  const reload = useCallback(async () => {
    try {
      const keys = await listCliKeys(userId);
      if (storeRef.current !== store) return;
      setLoaded({ store, keys });
      setListError(null);
    } catch (cause) {
      if (storeRef.current === store) setListError(vaultErrorMessage(cause));
    }
  }, [userId, store]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const keys = loaded?.store === store ? loaded.keys : null;
  const openRevocation = revocation?.store === store ? revocation.key : null;

  return (
    <PageSection
      label={COPY.label}
      note={COPY.note}
      error={openRevocation !== null ? null : (error ?? listError)}
    >
      {keys?.length === 0 && (
        <p className="text-2xs text-paper-faint">
          {COPY.emptyLead}
          <span className="font-mono text-paper-dim">{COPY.emptyCommand}</span>
          {COPY.emptyTail}
        </p>
      )}
      {keys !== null && keys.length > 0 && (
        <ul>
          {keys.map(key => (
            <li
              key={key.keyId}
              className="flex items-center gap-3 border-b border-rule-soft py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-paper">{key.name}</span>
                <span className="mt-0.5 block font-mono text-2xs text-paper-faint">
                  {key.pairingCode} · {COPY.added(key.createdAt)} · {COPY.lastUsed(key.lastUsedAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                className="-mr-2.5 shrink-0"
                disabled={isBusy}
                aria-label={COPY.revokeLabel(key)}
                onClick={() => setRevocation({ store, key })}
              >
                {COPY.revoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {openRevocation !== null && (
        <ConfirmDialog
          open
          onOpenChange={isOpen => {
            if (!isOpen) setRevocation(null);
          }}
          title={COPY.dialogTitle}
          description={COPY.dialogDescription(openRevocation)}
          confirmLabel={COPY.confirm}
          busyLabel={COPY.busy}
          onConfirm={async () => {
            // A dialog that closes on a refusal would hide it; one asking for a fresh sign-in closes.
            const failure = await run('cliKeys', async isCurrent => {
              try {
                await revokeCliKey({ userId, keyId: openRevocation.keyId });
              } finally {
                // Whatever the answer, the list may no longer be what it was (`yozz logout`).
                if (isCurrent()) await reload();
              }
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
