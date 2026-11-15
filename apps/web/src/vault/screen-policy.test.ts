import { VaultApiError } from '@yozz.app/mail/vault/api';
import { VaultError, type VaultFailureCode } from '@yozz.app/vault';
import { ApiErrorCodeSchema } from '@yozz.app/vault-contract';
import { describe, expect, it } from 'vitest';
import { PasskeyPrfError, type PrfCapability } from './passkey-prf';
import { PASSKEY_OFFER, vaultErrorMessage } from './screen-policy';
import { UnlockError } from './unlock';

describe('PASSKEY_OFFER', () => {
  it('is total over PrfCapability and offers passkey for supported and unknown', () => {
    const capabilities = [
      'supported',
      'unsupported',
      'unknown',
    ] as const satisfies readonly PrfCapability[];
    for (const capability of capabilities) {
      expect(PASSKEY_OFFER[capability]).toBeDefined();
    }
    expect(PASSKEY_OFFER.unsupported.canOffer).toBe(false);
    expect(PASSKEY_OFFER.supported.canOffer).toBe(true);
    expect(PASSKEY_OFFER.unknown.canOffer).toBe(true);
  });

  it('has notes for unsupported and unknown, and none for supported', () => {
    expect(PASSKEY_OFFER.unsupported.note).not.toBeNull();
    expect(PASSKEY_OFFER.unknown.note).not.toBeNull();
    expect(PASSKEY_OFFER.supported.note).toBeNull();
  });
});

describe('vaultErrorMessage', () => {
  it('covers every ApiErrorCode and NETWORK_ERROR with a non-empty string', () => {
    const codes = [...ApiErrorCodeSchema.options, 'NETWORK_ERROR'] as const;
    for (const code of codes) {
      const message = vaultErrorMessage(new VaultApiError(code, 'raw'));
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe('raw');
    }
  });

  it('covers every VaultFailureCode with a non-empty string', () => {
    const codes: VaultFailureCode[] = ['unreadable', 'malformed', 'stale'];
    for (const code of codes) {
      const message = vaultErrorMessage(new VaultError(code, 'detail'));
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain('detail');
    }
  });

  it('maps each branch to the screen copy', () => {
    expect(vaultErrorMessage(new VaultApiError('NETWORK_ERROR', 'x'))).toBe(
      "Couldn't reach YOZZ. Check your connection and try again.",
    );
    expect(vaultErrorMessage(new VaultApiError('UNAUTHORIZED', 'x'))).toBe(
      'Your login has expired. Request a new link.',
    );
    expect(vaultErrorMessage(new VaultApiError('FORBIDDEN', 'x'))).toBe("That isn't allowed.");
    expect(vaultErrorMessage(new VaultApiError('NOT_FOUND', 'x'))).toBe(
      'This passkey is not set up for your account. Log in on a device that already works, then add this one from Settings.',
    );
    expect(vaultErrorMessage(new VaultApiError('CONFLICT', 'x'))).toBe(
      'Another tab or device set up your account first. Log in there instead of setting it up again.',
    );
    expect(vaultErrorMessage(new VaultApiError('BAD_REQUEST', 'x'))).toBe(
      'Something went wrong. Try again.',
    );
    expect(vaultErrorMessage(new VaultApiError('PAYLOAD_TOO_LARGE', 'x'))).toBe(
      'That is too large to save. Remove some of it and try again.',
    );
    expect(vaultErrorMessage(new VaultApiError('INTERNAL_ERROR', 'x'))).toBe(
      'Something went wrong on our side. Try again.',
    );
    expect(vaultErrorMessage(new VaultApiError('INVALID_MODE', 'x'))).toBe(
      "This account doesn't log in that way. Reload the page and try again.",
    );

    expect(vaultErrorMessage(new VaultError('unreadable', 'x'))).toBe(
      'That did not unlock your saved addresses. Try again, and check your password if you used one.',
    );
    expect(vaultErrorMessage(new VaultError('malformed', 'x'))).toBe(
      'Something went wrong reading your saved addresses. Reload and try again.',
    );
    expect(vaultErrorMessage(new VaultError('stale', 'x'))).toBe(
      'YOZZ returned an older copy of your saved addresses than this device has seen, so nothing was read. Reload and try again.',
    );

    const prfMessage = 'PRF refused on this authenticator.';
    expect(vaultErrorMessage(new PasskeyPrfError(prfMessage))).toBe(prfMessage);

    const unlockMessage =
      'This account already logs in with a password. Switch modes to keep it, or start again first — creating one now would leave every saved record unreadable.';
    expect(vaultErrorMessage(new UnlockError(unlockMessage))).toBe(unlockMessage);

    const cancelled = 'The passkey prompt was cancelled or timed out. Try again.';
    expect(vaultErrorMessage(new DOMException('', 'NotAllowedError'))).toBe(cancelled);
    // SimpleWebAuthn re-throws the same dismissal as a plain Error carrying the spec boilerplate,
    // and Better Auth hands that message on; it must not reach the screen.
    expect(
      vaultErrorMessage(
        new PasskeyPrfError(
          'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.',
        ),
      ),
    ).toBe(cancelled);
    // Better Auth's passkey sign-in swaps the browser's error for its own AUTH_CANCELLED copy.
    expect(vaultErrorMessage(new PasskeyPrfError('Auth cancelled'))).toBe(cancelled);
    expect(vaultErrorMessage(new Error('plain failure'))).toBe('plain failure');
    expect(vaultErrorMessage('thrown string')).toBe('Something went wrong. Try again.');
  });
});
