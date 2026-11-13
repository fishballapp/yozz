import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import { useEffect, useState } from 'react';
import { Button, LinkButton, linkClass } from '../ui/Button';
import { FieldHint } from '../ui/Field';
import { AuthColumn, authActionClass, authHeadingClass, authProseClass } from './AuthColumn';
import { vaultApi } from './api';
import { isApiConfigured } from './api-base-url';
import { getSession } from './auth-client';
import { PasswordFields } from './PasswordFields';
import { checkPasskeyPrfCapability, PasskeyPrfError, type PrfCapability } from './passkey-prf';
import { SetupSteps } from './SetupSteps';
import { PASSKEY_OFFER, vaultErrorMessage } from './screen-policy';
import { useVault } from './session';
import {
  createPasskeyVault,
  createPasswordVault,
  MIN_PASSWORD_LENGTH,
  resetVaultAccount,
  UnlockError,
  type VaultAccount,
} from './unlock';

/** `account` is the sign-in this screen found; what it creates or resets is that account's. */
type EnrolStep =
  | { readonly step: 'checking' }
  | {
      readonly step: 'reset';
      readonly account: VaultAccount;
      readonly mode: 'password' | 'passkey';
    }
  | { readonly step: 'choose'; readonly account: VaultAccount; readonly prf: PrfCapability };

export const Enrol = () => {
  const navigate = useNavigate();
  const { reset } = useSearch({ from: '/enrol' });
  const { setSession, lock } = useVault();

  const [enrolStep, setEnrolStep] = useState<EnrolStep>({ step: 'checking' });
  const [busyKind, setBusyKind] = useState<'passkey' | 'password' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPanel, setErrorPanel] = useState<'passkey' | 'password' | 'reset' | null>(null);
  const [errorExtra, setErrorExtra] = useState<'login' | 'welcome' | 'password-instead' | null>(
    null,
  );

  // The password path waits behind a link while a passkey is on offer, so it does not compete with it.
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const isBusy = busyKind !== null;

  useEffect(() => {
    // AuthColumn shows the not-configured notice in place of the form, but this probe is not in
    // the form: without the guard it would still call getSession() against the production
    // fallback URL.
    if (!isApiConfigured()) return;
    void (async () => {
      try {
        const session = await getSession();
        if (!session?.data?.user) {
          void navigate({ to: '/welcome', search: previous => previous, replace: true });
          return;
        }
        const account = { userId: session.data.user.id, email: session.data.user.email };

        const status = await vaultApi.forAccount(account.userId).getUnlockStatus();
        if (status.mode !== null && reset !== true) {
          void navigate({ to: '/login', search: previous => previous, replace: true });
          return;
        }
        if (status.mode !== null && reset === true) {
          setEnrolStep({ step: 'reset', account, mode: status.mode });
          return;
        }

        const prf = await checkPasskeyPrfCapability();
        setEnrolStep({ step: 'choose', account, prf });
      } catch (err) {
        setError(vaultErrorMessage(err));
        setErrorPanel('reset');
      }
    })();
  }, [navigate, reset]);

  const handleEnrolError = (err: unknown, panel: 'passkey' | 'password') => {
    setError(vaultErrorMessage(err));
    setErrorPanel(panel);
    if (err instanceof UnlockError && err.message.startsWith('This account already has')) {
      void navigate({ to: '/login', search: previous => previous });
      setErrorExtra(null);
      return;
    }
    if (err instanceof VaultApiError && err.code === 'CONFLICT') {
      setErrorExtra('login');
      return;
    }
    if (err instanceof VaultApiError && err.code === 'UNAUTHORIZED') {
      setErrorExtra('welcome');
      return;
    }
    if (panel === 'passkey' && err instanceof PasskeyPrfError) {
      setErrorExtra('password-instead');
      setIsPasswordOpen(true);
      return;
    }
    setErrorExtra(null);
  };

  const renderError = (panel: 'passkey' | 'password' | 'reset') =>
    error === null || errorPanel !== panel ? null : (
      <div className="mt-3 space-y-2">
        <p role="alert" className="text-base text-danger">
          {error}
          {errorExtra === 'password-instead' ? ' Set a password below instead.' : ''}
        </p>
        {errorExtra === 'login' && (
          <Link to="/login" search={previous => previous} className={linkClass}>
            Log in instead
          </Link>
        )}
        {errorExtra === 'welcome' && (
          <Link to="/welcome" search={previous => previous} className={linkClass}>
            Request a new link
          </Link>
        )}
      </div>
    );

  if (enrolStep.step === 'checking') {
    return (
      <AuthColumn title="Setting up your login" description="Checking your link…">
        {error !== null && (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        )}
      </AuthColumn>
    );
  }

  if (enrolStep.step === 'reset') {
    return (
      <AuthColumn
        title="Start again"
        description="The recovery link got you into your account, but it can't unlock your saved addresses. Starting again deletes everything YOZZ stores for you, so you add each address back. Revoke each old password at its provider and make a new one."
        footer={
          <Link to="/login" search={previous => previous} className={linkClass}>
            Cancel and log in
          </Link>
        }
      >
        <Button
          variant="danger"
          className={authActionClass}
          disabled={isBusy}
          onClick={() => {
            void (async () => {
              setBusyKind('reset');
              setError(null);
              setErrorExtra(null);
              try {
                await resetVaultAccount(enrolStep.account.userId);
                await lock();
                const prf = await checkPasskeyPrfCapability();
                setEnrolStep({ step: 'choose', account: enrolStep.account, prf });
              } catch (err) {
                setError(vaultErrorMessage(err));
                setErrorPanel('reset');
              } finally {
                setBusyKind(null);
              }
            })();
          }}
        >
          {busyKind === 'reset' ? 'Starting again…' : 'Start again'}
        </Button>
        {renderError('reset')}
      </AuthColumn>
    );
  }

  const { account, prf } = enrolStep;
  const canOfferPasskey = PASSKEY_OFFER[prf].canOffer;
  // Open when it is the only path, when asked for, or while it holds what went wrong with it.
  const showsPasswordForm =
    !canOfferPasskey || isPasswordOpen || (error !== null && errorPanel === 'password');

  return (
    <AuthColumn
      title="Choose how you log in"
      progress={<SetupSteps current={2} />}
      footer={
        <p className="text-base text-paper-dim">
          You can switch later in Settings.{' '}
          <Link to="/login" search={previous => previous} className="text-paper underline">
            Log in instead
          </Link>
          .
        </p>
      }
    >
      {canOfferPasskey && (
        <div className="space-y-4">
          <h2 className={authHeadingClass}>Passkey (recommended)</h2>
          <p className={authProseClass}>
            Log in with Face ID, Touch ID or your security key. Your browser asks twice: once to
            create the passkey, once to unlock YOZZ with it.
          </p>
          {PASSKEY_OFFER[prf].note !== null && (
            <p className="text-2xs text-paper-faint">{PASSKEY_OFFER[prf].note}</p>
          )}
          <Button
            variant="primary"
            className={authActionClass}
            disabled={isBusy}
            onClick={async () => {
              setBusyKind('passkey');
              setError(null);
              setErrorExtra(null);
              try {
                const session = await createPasskeyVault({ account });
                setSession(session);
                void navigate({
                  to: '/m/$view',
                  params: { view: 'unified' },
                  search: previous => previous,
                });
              } catch (err) {
                handleEnrolError(err, 'passkey');
              } finally {
                setBusyKind(null);
              }
            }}
          >
            {busyKind === 'passkey' ? 'Waiting for your authenticator…' : 'Create passkey'}
          </Button>
          {renderError('passkey')}
        </div>
      )}

      {!showsPasswordForm && (
        <div className="mt-8 border-t border-rule-soft pt-6">
          <LinkButton disabled={isBusy} onClick={() => setIsPasswordOpen(true)}>
            Use a password instead
          </LinkButton>
        </div>
      )}

      {showsPasswordForm && (
        <form
          className={
            canOfferPasskey ? 'mt-8 space-y-5 border-t border-rule-soft pt-8' : 'space-y-5'
          }
          onSubmit={async event => {
            event.preventDefault();
            setError(null);
            setErrorExtra(null);
            if (password.length < MIN_PASSWORD_LENGTH) {
              setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
              setErrorPanel('password');
              return;
            }
            if (password !== confirmPassword) {
              setError('The two passwords do not match.');
              setErrorPanel('password');
              return;
            }
            setBusyKind('password');
            try {
              const session = await createPasswordVault({ account, password });
              setSession(session);
              void navigate({
                to: '/m/$view',
                params: { view: 'unified' },
                search: previous => previous,
              });
            } catch (err) {
              handleEnrolError(err, 'password');
            } finally {
              setBusyKind(null);
            }
          }}
        >
          <h2 className={authHeadingClass}>Password</h2>
          {!canOfferPasskey && PASSKEY_OFFER.unsupported.note !== null && (
            <p className="text-2xs text-paper-faint">{PASSKEY_OFFER.unsupported.note}</p>
          )}
          <p className={authProseClass}>
            Use a long passphrase, {MIN_PASSWORD_LENGTH} characters or more. It unlocks your saved
            addresses in any browser.
          </p>
          <PasswordFields
            idPrefix="enrol"
            password={password}
            confirmPassword={confirmPassword}
            onPassword={setPassword}
            onConfirmPassword={setConfirmPassword}
            isDisabled={isBusy}
            autoFocus={isPasswordOpen}
          />
          <FieldHint tone="caution">
            We can't reset it. If you forget it, you start again and add your addresses back.
          </FieldHint>
          <Button type="submit" variant="secondary" className={authActionClass} disabled={isBusy}>
            {busyKind === 'password' ? 'Creating…' : 'Create password'}
          </Button>
          {busyKind === 'password' && (
            <p className="text-2xs text-paper-faint">
              650,000 PBKDF2 rounds, in this tab. The browser cannot report progress on it.
            </p>
          )}
          {renderError('password')}
        </form>
      )}
    </AuthColumn>
  );
};
