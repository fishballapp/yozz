import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { Button, buttonClass } from '../../ui/Button';
import { FieldRow, Input } from '../../ui/Field';
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
      back={{ label: 'Sign-in', to: '/settings/account' }}
    >
      <form className="max-w-xs space-y-3" onSubmit={submit}>
        <FieldRow label="Current password" htmlFor="change-current">
          <Input
            id="change-current"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={event => setCurrentPassword(event.target.value)}
            disabled={busy !== null}
          />
          {errorUnder('current')}
        </FieldRow>
        <FieldRow label="New password" htmlFor="change-password">
          <Input
            id="change-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={busy !== null}
          />
          {errorUnder('password')}
        </FieldRow>
        <FieldRow label="Confirm new password" htmlFor="change-confirm">
          <Input
            id="change-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={event => setConfirmPassword(event.target.value)}
            disabled={busy !== null}
          />
          {errorUnder('confirm')}
        </FieldRow>
        <p className="text-base leading-relaxed text-paper-dim">
          Your other devices are signed out, and sign in again with the new password. If you forget
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
