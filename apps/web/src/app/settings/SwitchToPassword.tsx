import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { type FormEvent, useState } from 'react';
import { Button, buttonClass } from '../../ui/Button';
import { proseClass } from '../../ui/PageSection';
import { PasswordFields } from '../../vault/PasswordFields';
import { useVault } from '../../vault/session';
import { MIN_PASSWORD_LENGTH, switchModeToPassword } from '../../vault/unlock';
import { SettingsPane } from './SettingsPane';
import { useSignInChange } from './SignInChange';

/** Sets a password for an account that logs in with a passkey; `ChangePassword` is for one that has a password. */
export const SwitchToPassword = () => {
  const navigate = useNavigate();
  const { session, setSession } = useVault();
  const { busy, errors, run, confirmDialog } = useSignInChange<'switch'>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldError, setFieldError] = useState<{
    readonly field: 'password' | 'confirm';
    readonly message: string;
  } | null>(null);

  if (session === null) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError({
        field: 'password',
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (password !== confirmPassword) {
      setFieldError({ field: 'confirm', message: 'The two passwords do not match.' });
      return;
    }
    setFieldError(null);
    void run('switch', async isCurrent => {
      const switched = await switchModeToPassword({ currentSession: session, isCurrent, password });
      // Switched on the server, so the next sign-in takes the password.
      if (switched.outcome === 'ended') return;
      setSession(switched.session);
      void navigate({ to: '/settings/account', search: { notice: 'switched' } });
    });
  };

  return (
    <SettingsPane
      title="Switch to a password"
      subline={session.email}
      back={{ label: 'Account', to: '/settings/account' }}
    >
      <form className="space-y-5 sm:max-w-xs" onSubmit={submit}>
        <PasswordFields
          idPrefix="switch"
          ground="sunken"
          autoFocus
          password={password}
          confirmPassword={confirmPassword}
          onPassword={setPassword}
          onConfirmPassword={setConfirmPassword}
          isDisabled={busy !== null}
          errors={{
            password: fieldError?.field === 'password' && (
              <p role="alert" className="text-2xs text-danger">
                {fieldError.message}
              </p>
            ),
            confirm: fieldError?.field === 'confirm' && (
              <p role="alert" className="text-2xs text-danger">
                {fieldError.message}
              </p>
            ),
          }}
        />
        <p className={cn('text-paper-dim', proseClass)}>
          If you forget this password, nobody can recover your saved addresses, not even us. You
          would add them again.
        </p>
        {errors.switch !== undefined && (
          <p role="alert" className="text-base text-danger">
            {errors.switch}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'switch' ? 'Saving…' : 'Save'}
          </Button>
          <Link
            to="/settings/account"
            search={previous => previous}
            className={buttonClass({ variant: 'ghost' })}
          >
            Cancel
          </Link>
        </div>
        {busy === 'switch' && (
          <p className="text-2xs text-paper-faint">This takes a few seconds.</p>
        )}
      </form>
      {confirmDialog}
    </SettingsPane>
  );
};
