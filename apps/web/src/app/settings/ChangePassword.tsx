import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { type FormEvent, useState } from 'react';
import { Button, buttonClass } from '../../ui/Button';
import { FieldRow, PasswordInput } from '../../ui/Field';
import { proseClass } from '../../ui/PageSection';
import { PasswordFields } from '../../vault/PasswordFields';
import { useVault } from '../../vault/session';
import {
  changePasswordOfSession,
  MIN_PASSWORD_LENGTH,
  WrongPasswordError,
} from '../../vault/unlock';
import { SettingsPane } from './SettingsPane';
import { useSignInChange } from './SignInChange';

type Field = 'current' | 'password' | 'confirm';

/** Replaces the password of an account that already has one; `SwitchToPassword` is for one that signs in with a passkey. */
export const ChangePassword = () => {
  const navigate = useNavigate();
  const { session, setSession } = useVault();
  const { busy, errors, run, confirmDialog } = useSignInChange<'change'>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldError, setFieldError] = useState<{
    readonly field: Field;
    readonly message: string;
  } | null>(null);

  if (session === null) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (currentPassword === '') {
      setFieldError({ field: 'current', message: 'Enter your current password.' });
      return;
    }
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
    void run('change', async isCurrent => {
      try {
        const changed = await changePasswordOfSession({
          currentSession: session,
          isCurrent,
          currentPassword,
          newPassword: password,
        });
        if (changed.outcome === 'ended') return;
        setSession(changed.session);
        void navigate({ to: '/settings/account', search: { notice: 'changed' } });
      } catch (err) {
        if (!(err instanceof WrongPasswordError)) throw err;
        if (isCurrent()) setFieldError({ field: 'current', message: err.message });
      }
    });
  };

  const errorUnder = (field: Field) =>
    fieldError?.field === field && (
      <p role="alert" className="text-2xs text-danger">
        {fieldError.message}
      </p>
    );

  return (
    <SettingsPane
      title="Change password"
      subline={session.email}
      back={{ label: 'Account', to: '/settings/account' }}
    >
      {/* Full width on a phone like every other form; a password's width from `sm`. Field groups sit
          further apart than a label from its field, so a status line reads as its own field's. */}
      <form className="space-y-5 sm:max-w-xs" onSubmit={submit}>
        <FieldRow label="Current password" htmlFor="change-current">
          <PasswordInput
            id="change-current"
            ground="sunken"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={event => setCurrentPassword(event.target.value)}
            disabled={busy !== null}
          />
          {errorUnder('current')}
        </FieldRow>
        <PasswordFields
          idPrefix="change"
          label="New password"
          ground="sunken"
          password={password}
          confirmPassword={confirmPassword}
          onPassword={setPassword}
          onConfirmPassword={setConfirmPassword}
          isDisabled={busy !== null}
          errors={{ password: errorUnder('password'), confirm: errorUnder('confirm') }}
        />
        <p className={cn('text-paper-dim', proseClass)}>
          Your other devices are signed out, and log in again with the new password. If you forget
          it, nobody can recover your saved addresses, not even us. You would add them again.
        </p>
        {errors.change !== undefined && (
          <p role="alert" className="text-base text-danger">
            {errors.change}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'change' ? 'Saving…' : 'Save'}
          </Button>
          <Link
            to="/settings/account"
            search={previous => previous}
            className={buttonClass({ variant: 'ghost' })}
          >
            Cancel
          </Link>
        </div>
        {busy === 'change' && (
          <p className="text-2xs text-paper-faint">This takes a few seconds.</p>
        )}
      </form>
      {confirmDialog}
    </SettingsPane>
  );
};
