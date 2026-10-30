import { Link, useNavigate } from '@tanstack/react-router';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { useState } from 'react';
import { Button, buttonClass } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { PageSection } from '../../ui/PageSection';
import { getApiBaseUrl, isApiConfigured } from '../../vault/api-base-url';
import { signOut } from '../../vault/auth-client';
import { useVault } from '../../vault/session';
import { deleteAccount } from '../../vault/unlock';
import { CLI_KEY_FRESH_SIGN_IN, CliKeysSection } from './CliKeys';
import { PasskeysSection } from './Passkeys';
import { SettingsPane } from './SettingsPane';
import { usePasskeyOffer, useSignInChange } from './SignInChange';

/** The sections that run an action here, each with its own place for a failure. */
type Area = 'passkeys' | 'cliKeys' | 'session' | 'delete';

/** Typed to confirm: a word autofill cannot supply and a thumb will not type by accident. */
const DELETE_WORD = 'DELETE';

/** What **Confirm it's you** says when deleting the account asked for it. */
const DELETE_FRESH_SIGN_IN =
  'You signed in more than a day ago. Deleting your account needs a fresh sign-in, so a session someone else got hold of cannot do it. It is deleted right after.';

/** The notice a change leaves behind, read from the URL the change returns to. */
export type SignInNotice = 'switched' | 'changed';

const NOTICE_TEXT: Record<SignInNotice, string> = {
  switched: 'Switched.',
  changed: 'Password changed.',
};

export const Account = ({ notice }: { notice?: SignInNotice }) => {
  const navigate = useNavigate();
  const { session, lock } = useVault();
  const offer = usePasskeyOffer();
  const { busy, errors, run, confirmDialog } = useSignInChange<Area>({
    cliKeys: CLI_KEY_FRESH_SIGN_IN,
    delete: DELETE_FRESH_SIGN_IN,
  });
  // The delete question belongs to the session that opened it: a pane that outlives its session
  // (a sign-in as someone else in this tab) finds it closed and empty, never ready to delete them.
  const [deletion, setDeletion] = useState<{ store: RecordStore; typed: string } | null>(null);

  if (!isApiConfigured()) {
    return (
      <SettingsPane title="Sign-in">
        <div className="border-y border-rule bg-ink-raised px-4 py-3.5">
          <p className="label-rule">No backend configured</p>
          <p className="mt-2 max-w-xl text-base leading-relaxed text-paper-dim">
            The YOZZ API worker is needed to sign in, and no address for it was supplied at build
            time. Set <span className="font-mono text-2xs text-paper">VITE_API_URL</span> before
            starting the app. Nothing on this screen will work until then.
          </p>
          <p className="mt-3 font-mono text-2xs text-paper-faint">Would call {getApiBaseUrl()}</p>
        </div>
      </SettingsPane>
    );
  }

  if (session === null) {
    return (
      <SettingsPane title="Sign-in">
        <PageSection
          label="Not signed in"
          note="Your addresses and passwords are encrypted, and only you can open them. Your existing mail provider stays as it is. This device stays signed in until you sign out."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/login"
              search={previous => previous}
              className={buttonClass({ variant: 'secondary' })}
            >
              Log in
            </Link>
            <Link
              to="/welcome"
              search={previous => previous}
              className={buttonClass({ variant: 'ghost' })}
            >
              Create an account
            </Link>
          </div>
        </PageSection>
      </SettingsPane>
    );
  }

  const canOfferPasskey = offer?.canOffer === true;
  const openDeletion = deletion !== null && deletion.store === session.store ? deletion : null;
  const typed = openDeletion?.typed ?? '';

  return (
    <SettingsPane title="Sign-in" subline={session.email}>
      <PageSection label="Method">
        <p className="text-base text-paper">
          You sign in with a {session.mode === 'passkey' ? 'passkey' : 'password'}.
        </p>
        {notice !== undefined && (
          <p role="status" aria-live="polite" className="mt-1.5 text-base text-paper-dim">
            {NOTICE_TEXT[notice]}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {session.mode === 'password' && (
            <Link
              to="/settings/account/password"
              search={previous => previous}
              className={buttonClass({ variant: 'secondary' })}
            >
              Change password
            </Link>
          )}
          {session.mode === 'password' && canOfferPasskey && (
            <Link
              to="/settings/account/passkey"
              search={previous => previous}
              className={buttonClass({ variant: 'secondary' })}
            >
              Switch to a passkey
            </Link>
          )}
          {session.mode === 'passkey' && (
            <Link
              to="/settings/account/password"
              search={previous => previous}
              className={buttonClass({ variant: 'secondary' })}
            >
              Switch to a password
            </Link>
          )}
        </div>
        {session.mode === 'password' &&
          offer !== null &&
          !canOfferPasskey &&
          offer.note !== null && <p className="mt-3 text-2xs text-paper-faint">{offer.note}</p>}
      </PageSection>

      {session.mode === 'passkey' && canOfferPasskey && (
        <PasskeysSection
          session={session}
          isBusy={busy !== null}
          error={errors.passkeys}
          run={run}
        />
      )}

      <CliKeysSection session={session} isBusy={busy !== null} error={errors.cliKeys} run={run} />

      <PageSection
        label="Session"
        note="Signing out keeps your data as it is. Sign in again to open it."
        error={errors.session}
      >
        <Button
          variant="ghost"
          className="-ml-3"
          disabled={busy !== null}
          onClick={() =>
            void run('session', async isCurrent => {
              try {
                // Better Auth reports a refused sign-out as `{ error }`; this device is locked either way.
                const res = await signOut(session.userId);
                if (!isCurrent()) return;
                if (res.error) throw new Error(res.error.message || 'Signing out failed.');
                void navigate({ to: '/login', search: previous => previous });
              } finally {
                // The session after this one is not this button's to lock.
                if (isCurrent()) await lock();
              }
            })
          }
        >
          {busy === 'session' ? 'Signing out…' : 'Sign out'}
        </Button>
      </PageSection>

      <PageSection
        label="Delete account"
        note="Deletes your YOZZ account, your saved addresses and their passwords, your drafts, and everything else stored here. It cannot reach your mail: what is at your providers, including the Sent copies and draft copies YOZZ put in your mailboxes, stays there."
        error={openDeletion !== null ? null : errors.delete}
      >
        <Button
          variant="danger"
          className="-ml-3"
          disabled={busy !== null}
          onClick={() => {
            setDeletion({ store: session.store, typed: '' });
          }}
        >
          Delete account
        </Button>
        <ConfirmDialog
          open={openDeletion !== null}
          onOpenChange={isOpen => setDeletion(isOpen ? { store: session.store, typed: '' } : null)}
          title="Delete your account?"
          description={`This cannot be undone. ${session.email} and everything stored for it are deleted, and you are signed out.`}
          confirmLabel="Delete account"
          busyLabel="Deleting…"
          isConfirmEnabled={typed.trim() === DELETE_WORD}
          onConfirm={async () => {
            // A dialog that closes on a refusal would hide it; one asking for a fresh sign-in closes.
            const failure = await run('delete', async isCurrent => {
              // Still the session the word was typed in.
              if (!isCurrent()) return;
              await deleteAccount(session.userId);
              if (!isCurrent()) return;
              // Navigating is last: locking drops the session and the shell sends a signed-out
              // visitor to a bare Log in, which would take the notice's place if it came first.
              await lock();
              void navigate({ to: '/login', search: { deleted: true } });
            });
            if (failure !== null) throw new Error(failure);
          }}
        >
          <div className="mt-4">
            <FieldRow label={`Type ${DELETE_WORD} to confirm`} htmlFor="delete-account-confirm">
              <Input
                id="delete-account-confirm"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                value={typed}
                onChange={event => setDeletion({ store: session.store, typed: event.target.value })}
                disabled={busy !== null}
              />
            </FieldRow>
          </div>
          {errors.delete !== undefined && (
            <p role="alert" className="mt-3 text-base text-danger">
              {errors.delete}
            </p>
          )}
        </ConfirmDialog>
      </PageSection>

      {confirmDialog}
    </SettingsPane>
  );
};
