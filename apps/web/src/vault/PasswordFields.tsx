import type { ReactNode } from 'react';
import { FieldRow, PasswordInput } from '../ui/Field';
import { MIN_PASSWORD_LENGTH } from './unlock';

const lengthStatus = (length: number): string => {
  if (length === 0) return `${MIN_PASSWORD_LENGTH} characters minimum`;
  return `${length} ${length === 1 ? 'character' : 'characters'} · ${MIN_PASSWORD_LENGTH} minimum`;
};

/**
 * A new password and its confirmation, each readable on demand, with a live line under each: the
 * length against the minimum, and whether the two match. A password nobody can reset is where a
 * typo costs most.
 */
export const PasswordFields = ({
  idPrefix,
  label = 'Password',
  password,
  confirmPassword,
  onPassword,
  onConfirmPassword,
  isDisabled,
  autoFocus,
  ground,
  errors = {},
}: {
  idPrefix: string;
  label?: string;
  password: string;
  confirmPassword: string;
  onPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  isDisabled: boolean;
  autoFocus?: boolean;
  ground?: 'page' | 'sunken';
  /** What a submit found wrong with either field, said under it. */
  errors?: { readonly password?: ReactNode; readonly confirm?: ReactNode };
}) => {
  const passwordId = `${idPrefix}-password`;
  const confirmId = `${idPrefix}-confirm`;
  const isMatch = confirmPassword === password;
  return (
    <>
      <FieldRow
        label={label}
        htmlFor={passwordId}
        status={lengthStatus(password.length)}
        isStatusMet={password.length >= MIN_PASSWORD_LENGTH}
      >
        <PasswordInput
          id={passwordId}
          autoComplete="new-password"
          autoFocus={autoFocus}
          aria-describedby={`${passwordId}-status`}
          ground={ground}
          value={password}
          onChange={event => onPassword(event.target.value)}
          disabled={isDisabled}
        />
        {errors.password}
      </FieldRow>
      <FieldRow
        label={`Confirm ${label.toLowerCase()}`}
        htmlFor={confirmId}
        status={(() => {
          // Silent until the second one is started.
          if (confirmPassword === '') return null;
          return isMatch ? 'Matches' : 'Doesn’t match yet';
        })()}
        isStatusMet={confirmPassword !== '' && isMatch}
      >
        <PasswordInput
          id={confirmId}
          autoComplete="new-password"
          aria-describedby={`${confirmId}-status`}
          ground={ground}
          value={confirmPassword}
          onChange={event => onConfirmPassword(event.target.value)}
          disabled={isDisabled}
        />
        {errors.confirm}
      </FieldRow>
    </>
  );
};
