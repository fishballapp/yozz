import { Link, useNavigate } from '@tanstack/react-router';
import { Button, buttonClass } from '../../ui/Button';
import { PageSection } from '../../ui/PageSection';
import { PASSKEY_OFFER } from '../../vault/screen-policy';
import { useVault } from '../../vault/session';
import { switchModeToPasskey } from '../../vault/unlock';
import { SettingsPane } from './SettingsPane';
import { usePasskeyOffer, useSignInChange } from './SignInChange';

/** Moves an account that signs in with a password onto a passkey, on this device. */
export const SwitchToPasskey = () => {
  const navigate = useNavigate();
  const { session, setSession } = useVault();
  const offer = usePasskeyOffer();
  const { busy, errors, run, confirmDialog } = useSignInChange<'switch'>();

  if (session === null) return null;

  if (session.mode === 'passkey') {
    return (
      <SettingsPane
        title="Switch to a passkey"
        subline={session.email}
        back={{ label: 'Sign-in', to: '/settings/account' }}
      >
        <PageSection label="Passkey" note="You already sign in with a passkey.">
          <Link
            to="/settings/account"
            search={previous => previous}
            className={buttonClass({ variant: 'secondary' })}
          >
            Back to Account
          </Link>
        </PageSection>
      </SettingsPane>
    );
  }

  const canOffer = offer?.canOffer === true;

  return (
    <SettingsPane
      title="Switch to a passkey"
      subline={session.email}
      back={{ label: 'Sign-in', to: '/settings/account' }}
    >
      <PageSection
        label="Passkey"
        note="Your password stops working for signing in, and a passkey takes its place. Your addresses stay as they are."
        error={errors.switch}
      >
        {canOffer ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() =>
                void run('switch', async isCurrent => {
                  const switched = await switchModeToPasskey({
                    currentSession: session,
                    isCurrent,
                  });
                  // Switched on the server; the next sign-in asks for the passkey.
                  if (switched.outcome !== 'switched') return;
                  setSession(switched.session);
                  void navigate({ to: '/settings/account', search: { notice: 'switched' } });
                })
              }
            >
              {busy === 'switch' ? 'Waiting for your authenticator…' : 'Switch to a passkey'}
            </Button>
            <Link
              to="/settings/account"
              search={previous => previous}
              className={buttonClass({ variant: 'ghost' })}
            >
              Cancel
            </Link>
          </div>
        ) : (
          <p className="text-base text-paper-dim">
            {offer?.note ?? PASSKEY_OFFER.unsupported.note}
          </p>
        )}
      </PageSection>
      {confirmDialog}
    </SettingsPane>
  );
};
