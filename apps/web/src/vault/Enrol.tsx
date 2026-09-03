import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { FieldRow, Input } from '../ui/Field';
import { AuthColumn } from './AuthColumn';
import { VaultApiError, vaultApi } from './api';
import { isApiConfigured } from './api-base-url';
import { getSession } from './auth-client';
import { checkPasskeyPrfCapability, PasskeyPrfError, type PrfCapability } from './passkey-prf';
import { PASSKEY_OFFER, vaultErrorMessage } from './screen-policy';
import { useVault } from './session';
import {
  createPasskeyVault,
  createPasswordVault,
  MIN_PASSWORD_LENGTH,
  resetVaultAccount,
  UnlockError,
} from './unlock';

type EnrolStep =
  | { readonly step: 'checking' }
  | { readonly step: 'reset'; readonly mode: 'password' | 'passkey' }
  | { readonly step: 'choose'; readonly prf: PrfCapability };

export const Enrol = () => {
  const navigate = useNavigate();
  const { reset } = useSearch({ from: '/enrol' });
  const { setSession, lock } = useVault();

  const [enrolStep, setEnrolStep] = useState<EnrolStep>({ step: 'checking' });
  const [email, setEmail] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<'passkey' | 'password' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPanel, setErrorPanel] = useState<'passkey' | 'password' | 'reset' | null>(null);
  const [errorExtra, setErrorExtra] = useState<'login' | 'welcome' | 'password-instead' | null>(
    null,
  );

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
        setEmail(session.data.user.email);

        const status = await vaultApi.getUnlockStatus();
        if (status.mode !== null && reset !== '1') {
          void navigate({ to: '/login', search: previous => previous, replace: true });
          return;
        }
        if (status.mode !== null && reset === '1') {
          setEnrolStep({ step: 'reset', mode: status.mode });
          return;
        }

        const prf = await checkPasskeyPrfCapability();
        setEnrolStep({ step: 'choose', prf });
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
          <Link
            to="/login"
            search={previous => previous}
            className="text-base text-paper underline"
          >
            Log in instead
          </Link>
        )}
        {errorExtra === 'welcome' && (
          <Link
            to="/welcome"
            search={previous => previous}
            className="text-base text-paper underline"
          >
            Request a new link
          </Link>
        )}
      </div>
    );

  if (enrolStep.step === 'checking') {
    return (
      <AuthColumn title="Setting up your vault" description="Checking this sign-in…">
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
        title="Reset your vault"
        description="A recovery link restores your YOZZ account. It cannot open your vault: the link proves your address and holds no key. Resetting deletes every stored record and gives you a new one, and nothing is lost that cannot be made again. Revoke each password at your provider, generate a new one, add the account back."
        footer={
          <Link
            to="/login"
            search={previous => previous}
            className="text-base text-paper-dim underline"
          >
            Cancel and log in
          </Link>
        }
      >
        <Button
          variant="danger"
          disabled={isBusy}
          onClick={() => {
            void (async () => {
              setBusyKind('reset');
              setError(null);
              setErrorExtra(null);
              try {
                await resetVaultAccount();
                await lock();
                const prf = await checkPasskeyPrfCapability();
                setEnrolStep({ step: 'choose', prf });
              } catch (err) {
                setError(vaultErrorMessage(err));
                setErrorPanel('reset');
              } finally {
                setBusyKind(null);
              }
            })();
          }}
        >
          {busyKind === 'reset' ? 'Resetting…' : 'Reset the vault'}
        </Button>
        {renderError('reset')}
      </AuthColumn>
    );
  }

  const { prf } = enrolStep;
  const canOfferPasskey = PASSKEY_OFFER[prf].canOffer;

  return (
    <AuthColumn
      title="Choose how you log in"
      footer={
        <p className="text-base text-paper-dim">
          Choosing one retires the other. You can switch in Settings.{' '}
          <Link to="/login" search={previous => previous} className="text-paper underline">
            Log in instead
          </Link>
          .
        </p>
      }
    >
      {canOfferPasskey && (
        <div className="space-y-4">
          <h2 className="label-rule">Passkey (recommended)</h2>
          <p className="text-base leading-relaxed text-paper-dim">
            One gesture signs you in and opens your vault. The key is derived by your authenticator
            and never reaches us.
          </p>
          <p className="text-base leading-relaxed text-paper-dim">
            Your browser will ask twice: once to create the passkey, once to derive the key it
            protects. Both prompts are the same passkey.
          </p>
          {PASSKEY_OFFER[prf].note !== null && (
            <p className="text-2xs text-paper-faint">{PASSKEY_OFFER[prf].note}</p>
          )}
          <Button
            variant="primary"
            disabled={isBusy}
            onClick={() => {
              void (async () => {
                setBusyKind('passkey');
                setError(null);
                setErrorExtra(null);
                try {
                  const session = await createPasskeyVault();
                  setSession(session);
                  void navigate({
                    to: '/m/$mailbox',
                    params: { mailbox: 'unified' },
                    search: previous => previous,
                  });
                } catch (err) {
                  handleEnrolError(err, 'passkey');
                } finally {
                  setBusyKind(null);
                }
              })();
            }}
          >
            {busyKind === 'passkey' ? 'Waiting for your authenticator…' : 'Create passkey'}
          </Button>
          {renderError('passkey')}
        </div>
      )}

      <div
        className={canOfferPasskey ? 'mt-8 space-y-4 border-t border-rule-soft pt-8' : 'space-y-4'}
      >
        <h2 className="label-rule">Password</h2>
        {!canOfferPasskey && PASSKEY_OFFER.unsupported.note !== null && (
          <p className="text-2xs text-paper-faint">{PASSKEY_OFFER.unsupported.note}</p>
        )}
        <p className="text-base leading-relaxed text-paper-dim">
          Your password is the only key. It never leaves this browser, and nothing else has to be
          carried to a new one, so any browser you can type it into opens the vault.
        </p>
        <p className="text-base leading-relaxed text-paper-dim">
          Make it a passphrase rather than a password. It is the only thing standing between the
          vault and whoever holds a copy of the encrypted data, and twelve characters is the floor
          rather than the target.
        </p>
        <p className="text-base leading-relaxed text-paper-dim">
          There is no recovery. Lose the password and the vault resets, which is safe here because
          every credential in it can be made again at your provider.
        </p>
        <FieldRow label="Password" htmlFor="enrol-password">
          <Input
            id="enrol-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <FieldRow label="Confirm password" htmlFor="enrol-confirm">
          <Input
            id="enrol-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={event => setConfirmPassword(event.target.value)}
            disabled={isBusy}
          />
        </FieldRow>
        <Button
          variant="secondary"
          disabled={isBusy || email === null}
          onClick={() => {
            void (async () => {
              setBusyKind('password');
              setError(null);
              setErrorExtra(null);
              try {
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
                if (email === null) return;
                const session = await createPasswordVault({ email, password });
                setSession(session);
                void navigate({
                  to: '/m/$mailbox',
                  params: { mailbox: 'unified' },
                  search: previous => previous,
                });
              } catch (err) {
                handleEnrolError(err, 'password');
              } finally {
                setBusyKind(null);
              }
            })();
          }}
        >
          {busyKind === 'password' ? 'Deriving keys…' : 'Create vault'}
        </Button>
        {busyKind === 'password' && (
          <p className="text-2xs text-paper-faint">
            650,000 PBKDF2 rounds, in this tab. The browser cannot report progress on it.
          </p>
        )}
        {renderError('password')}
      </div>
    </AuthColumn>
  );
};
