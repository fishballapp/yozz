import { VaultApiError } from '@yozz.app/mail/vault/api';
import { VaultError, type VaultFailureCode } from '@yozz.app/vault';
import type { ApiErrorCode } from '@yozz.app/vault-contract';
import { PasskeyPrfError, type PrfCapability } from './passkey-prf';
import { UnlockError } from './unlock';

/** What a PRF probe permits a screen to OFFER. `unknown` still offers passkey. */
export const PASSKEY_OFFER: Record<
  PrfCapability,
  { readonly canOffer: boolean; readonly note: string | null }
> = {
  supported: { canOffer: true, note: null },
  unknown: {
    canOffer: true,
    note: 'This browser does not report whether a passkey can unlock your saved addresses. You can still try; if the authenticator cannot, use a password instead.',
  },
  unsupported: {
    canOffer: false,
    note: 'This browser cannot use a passkey to unlock your saved addresses. Use a password instead.',
  },
};

const API_ERROR_MESSAGES: Record<ApiErrorCode | 'NETWORK_ERROR', string> = {
  NETWORK_ERROR: "Couldn't reach YOZZ. Check your connection and try again.",
  UNAUTHORIZED: 'Your login has expired. Request a new link.',
  FORBIDDEN: "That isn't allowed.",
  NOT_FOUND:
    'This passkey is not set up for your account. Log in on a device that already works, then add this one from Settings.',
  CONFLICT:
    'Another tab or device set up your account first. Log in there instead of setting it up again.',
  BAD_REQUEST: 'Something went wrong. Try again.',
  PAYLOAD_TOO_LARGE: 'That is too large to save. Remove some of it and try again.',
  FILE_TOO_LARGE: 'That file is too large to attach. Choose a smaller one.',
  STORAGE_FULL: 'Your file storage is full. Remove an attachment and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side. Try again.',
  INVALID_MODE: "This account doesn't log in that way. Reload the page and try again.",
  SESSION_NOT_FRESH: 'Log in again to change how you log in.',
  WRONG_PASSWORD: 'That is not your current password.',
  ACCOUNT_MISMATCH:
    'This browser logged in to another account since this page opened, so nothing was changed. Log in again to go on.',
  UPGRADE_REQUIRED: 'Something went wrong. Try again.',
  RATE_LIMITED: 'Too many requests. Try again in a moment.',
  UPSTREAM_UNREACHABLE: "Couldn't reach your mail server. Check the host and port.",
};

const VAULT_ERROR_MESSAGES: Record<VaultFailureCode, string> = {
  unreadable:
    'That did not unlock your saved addresses. Try again, and check your password if you used one.',
  malformed: 'Something went wrong reading your saved addresses. Reload and try again.',
  stale:
    'YOZZ returned an older copy of your saved addresses than this device has seen, so nothing was read. Reload and try again.',
};

const PASSKEY_CANCELLED = 'The passkey prompt was cancelled or timed out. Try again.';

/**
 * A dismissed or timed-out WebAuthn prompt arrives as `NotAllowedError`, re-thrown by
 * SimpleWebAuthn as a plain Error carrying the spec boilerplate, or replaced by Better Auth's
 * passkey client with its `AUTH_CANCELLED` message.
 */
const isPasskeyCancelled = (error: Error) =>
  error.name === 'NotAllowedError' ||
  /timed out or was not allowed/i.test(error.message) ||
  error.message === 'Auth cancelled';

/** Every failure a vault screen can catch, as one sentence the reader can act on. */
export const vaultErrorMessage = (error: unknown): string => {
  if (error instanceof Error && isPasskeyCancelled(error)) {
    return PASSKEY_CANCELLED;
  }
  if (error instanceof VaultApiError) {
    return API_ERROR_MESSAGES[error.code];
  }
  if (error instanceof VaultError) {
    return VAULT_ERROR_MESSAGES[error.code];
  }
  if (error instanceof PasskeyPrfError) {
    return error.message;
  }
  if (error instanceof UnlockError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
};
