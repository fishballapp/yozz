import { VaultError, type VaultFailureCode } from '@yozz.app/vault';
import type { ApiErrorCode } from '@yozz.app/vault-contract';
import { VaultApiError } from './api.ts';
import { DeviceSecretMissingError, DeviceStorageError } from './device-secret.ts';
import { PasskeyPrfError, type PrfCapability } from './passkey-prf.ts';
import { UnlockError } from './unlock.ts';

/** What a PRF probe permits a screen to OFFER. `unknown` still offers passkey. */
export const PASSKEY_OFFER: Record<
  PrfCapability,
  { readonly canOffer: boolean; readonly note: string | null }
> = {
  supported: { canOffer: true, note: null },
  unknown: {
    canOffer: true,
    note: 'This browser does not report whether a passkey can derive a vault key. You can still try; if the authenticator cannot, set a password instead.',
  },
  unsupported: {
    canOffer: false,
    note: 'This browser cannot derive a vault key from a passkey. Use a password instead.',
  },
};

const API_ERROR_MESSAGES: Record<ApiErrorCode | 'NETWORK_ERROR', string> = {
  NETWORK_ERROR: 'The YOZZ API did not answer. Check that it is running and reachable.',
  UNAUTHORIZED: 'Your sign-in has expired. Request a new link.',
  FORBIDDEN: 'The server refused that request.',
  NOT_FOUND:
    'This passkey has no key wrap on your account. Log in on a device that already works, then add this one from Settings.',
  CONFLICT:
    'Another tab or device created this vault first. Log in to it instead of creating a second one.',
  BAD_REQUEST: 'The server rejected that request as malformed.',
  PAYLOAD_TOO_LARGE: 'That was too large to store.',
  INTERNAL_ERROR: 'The server failed on that request. Try again.',
  INVALID_MODE: 'This account is not in that login method.',
  UPGRADE_REQUIRED: 'A WebSocket connection is required.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  UPSTREAM_UNREACHABLE: 'Could not reach the upstream mail server. Check the host and port.',
};

const VAULT_ERROR_MESSAGES: Record<VaultFailureCode, string> = {
  unreadable:
    "That did not open the vault. In password mode the password and this device's secret both have to be right, and nothing can tell which one is wrong.",
  malformed: 'A stored value was not the shape it should be.',
  stale:
    'The server answered with an older version of a record than this device has already seen. Nothing was read.',
};

const PASSKEY_CANCELLED = 'The passkey prompt was cancelled or timed out. Try again.';

/**
 * A dismissed or timed-out WebAuthn prompt reaches us two ways: as the browser's own
 * `NotAllowedError` DOMException, or re-thrown by SimpleWebAuthn / Better Auth as a plain Error
 * whose message is the spec boilerplate ("The operation either timed out or was not allowed…").
 */
const isPasskeyCancelled = (error: Error) =>
  error.name === 'NotAllowedError' || /timed out or was not allowed/i.test(error.message);

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
  if (error instanceof DeviceSecretMissingError) {
    return 'This device has no device secret for that address. Paste the one exported from a device that is already logged in.';
  }
  if (error instanceof DeviceStorageError) {
    return 'This browser will not let YOZZ keep anything on this device. Password mode needs that; allow site data, or use a passkey.';
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
  return 'Something failed and gave no reason.';
};
