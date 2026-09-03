import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ServerKeysSection } from '../../relay/ServerKeysSection';
import { Button, buttonClass } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { FieldRow, Input } from '../../ui/Field';
import { Definition, PageSection } from '../../ui/PageColumn';
import { getApiBaseUrl, isApiConfigured } from '../../vault/api-base-url';
import { signOut } from '../../vault/auth-client';
import { checkPasskeyPrfCapability, type PrfCapability } from '../../vault/passkey-prf';
import { PASSKEY_OFFER, vaultErrorMessage } from '../../vault/screen-policy';
import { useVault } from '../../vault/session';
import {
  addPasskeyToSession,
  MIN_PASSWORD_LENGTH,
  resetVaultAccount,
  switchModeToPasskey,
  switchModeToPassword,
} from '../../vault/unlock';

/** One section per thing you might come here to do. */
export const Vault = () => {
  const navigate = useNavigate();
  const { session, setSession, lock } = useVault();

  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [prf, setPrf] = useState<PrfCapability | null>(null);

  const [isSwitchingToPassword, setIsSwitchingToPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [addedPasskeyNote, setAddedPasskeyNote] = useState(false);

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

  const run = async (action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  };

  if (!isApiConfigured()) {
    return (
      <div className="border-y border-rule bg-ink-raised px-4 py-3.5">
        <p className="label-rule">No backend configured</p>
        <p className="mt-2 max-w-xl text-base leading-relaxed text-paper-dim">
          The vault needs the YOZZ API worker, and no address for it was supplied at build time. Set{' '}
          <span className="font-mono text-2xs text-paper">VITE_API_URL</span> before starting the
          app. Nothing on this screen will work until then.
        </p>
        <p className="mt-3 font-mono text-2xs text-paper-faint">Would call {getApiBaseUrl()}</p>
      </div>
    );
  }

  if (session === null) {
    return (
      <>
        <PageSection
          label="Vault"
          note="Zero-knowledge applies to YOZZ: your addresses and passwords live in an encrypted store only you can open. Your existing mail provider remains unchanged. This device stays unlocked until you sign out."
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
        <ServerKeysSection />
      </>
    );
  }

  const canOfferPasskey = prf !== null && PASSKEY_OFFER[prf].canOffer;

  return (
    <>
      {error !== null && (
        <p role="alert" className="mb-6 text-base text-danger">
          {error}
        </p>
      )}

      <PageSection
        label="Sign-in"
        note="A vault has exactly one sign-in method. Switching retires the other one and rewraps the same key, so nothing is re-encrypted."
      >
        <dl>
          <Definition term="Method">{session.mode}</Definition>
          <Definition term="Address">{session.email}</Definition>
        </dl>
        <p className="mt-3 text-2xs text-paper-faint">
          The address is fixed. It is part of how the key is derived.
        </p>

        {session.mode === 'passkey' && (
          <div className="mt-4">
            {!isSwitchingToPassword ? (
              <Button
                variant="secondary"
                disabled={isBusy}
                onClick={() => setIsSwitchingToPassword(true)}
              >
                Switch to a password
              </Button>
            ) : (
              <div className="max-w-xs space-y-3">
                <FieldRow label="Password" htmlFor="vault-switch-password">
                  <Input
                    id="vault-switch-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    disabled={isBusy}
                  />
                </FieldRow>
                <FieldRow label="Confirm password" htmlFor="vault-switch-confirm">
                  <Input
                    id="vault-switch-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                    disabled={isBusy}
                  />
                </FieldRow>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() =>
                      void run(async () => {
                        if (password.length < MIN_PASSWORD_LENGTH) {
                          setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
                          return;
                        }
                        if (password !== confirmPassword) {
                          setError('The two passwords do not match.');
                          return;
                        }
                        const next = await switchModeToPassword({
                          currentSession: session,
                          password,
                        });
                        setSession(next);
                        setIsSwitchingToPassword(false);
                        setPassword('');
                        setConfirmPassword('');
                      })
                    }
                  >
                    {isBusy ? 'Deriving keys…' : 'Switch to a password'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={isBusy}
                    onClick={() => {
                      setIsSwitchingToPassword(false);
                      setPassword('');
                      setConfirmPassword('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {isBusy && (
                  <p className="text-2xs text-paper-faint">
                    650,000 PBKDF2 rounds, in this tab. The browser cannot report progress on it.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {session.mode === 'password' && (
          <div className="mt-4 space-y-3">
            {canOfferPasskey ? (
              <Button
                variant="secondary"
                disabled={isBusy}
                onClick={() =>
                  void run(async () => {
                    const next = await switchModeToPasskey({ currentSession: session });
                    setSession(next);
                  })
                }
              >
                {isBusy ? 'Waiting for your authenticator…' : 'Switch to a passkey'}
              </Button>
            ) : (
              prf !== null &&
              PASSKEY_OFFER[prf].note !== null && (
                <p className="text-2xs text-paper-faint">{PASSKEY_OFFER[prf].note}</p>
              )
            )}
          </div>
        )}
      </PageSection>

      {session.mode === 'passkey' && canOfferPasskey && (
        <PageSection
          label="Passkeys"
          note="Each authenticator gets its own wrap of the same key. Add one from a device before you need to log in on it."
        >
          <div className="space-y-3">
            <Button
              variant="secondary"
              disabled={isBusy}
              onClick={() =>
                void run(async () => {
                  await addPasskeyToSession({ currentSession: session });
                  setAddedPasskeyNote(true);
                })
              }
            >
              {isBusy ? 'Waiting for your authenticator…' : 'Add passkey'}
            </Button>
            {addedPasskeyNote && (
              <p className="text-base text-paper-dim">
                Added. That authenticator can now open this vault.
              </p>
            )}
          </div>
        </PageSection>
      )}

      <ServerKeysSection />

      <PageSection
        label="Reset"
        note="Every stored record is deleted and a new key is made. Your addresses have to be added again, with a fresh password from each provider. Nothing else about your YOZZ account changes."
      >
        <ConfirmDialog
          trigger={<Button variant="danger" disabled={isBusy} />}
          triggerLabel="Reset vault"
          title="Reset this vault?"
          description="Every stored record is deleted and a new key is made. Your addresses have to be added again, with a fresh password from each provider."
          confirmLabel="Reset vault"
          busyLabel="Resetting…"
          onConfirm={() =>
            run(async () => {
              await resetVaultAccount();
              await lock();
              void navigate({ to: '/enrol', search: previous => previous });
            })
          }
        />
      </PageSection>

      <PageSection label="Session" note="This device stays unlocked until you sign out.">
        <Button
          variant="ghost"
          disabled={isBusy}
          onClick={() => {
            void (async () => {
              setIsBusy(true);
              setError(null);
              try {
                // Better Auth reports a refused sign-out as `{ error }`; the local vault is closed either way.
                const res = await signOut();
                if (res.error) {
                  setError(res.error.message || 'Signing out failed.');
                  return;
                }
                void navigate({ to: '/login', search: previous => previous });
              } catch (err) {
                setError(vaultErrorMessage(err));
              } finally {
                await lock();
                setIsBusy(false);
              }
            })();
          }}
        >
          Sign out
        </Button>
      </PageSection>
    </>
  );
};
