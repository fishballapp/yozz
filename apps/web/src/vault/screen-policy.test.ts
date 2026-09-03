import { VaultError, type VaultFailureCode } from '@yozz.app/vault';
import { ApiErrorCodeSchema } from '@yozz.app/vault-contract';
import { describe, expect, it } from 'vitest';
import { VaultApiError } from './api';
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
      'The YOZZ API did not answer. Check that it is running and reachable.',
    );
    expect(vaultErrorMessage(new VaultApiError('UNAUTHORIZED', 'x'))).toBe(
      'Your sign-in has expired. Request a new link.',
    );
    expect(vaultErrorMessage(new VaultApiError('FORBIDDEN', 'x'))).toBe(
      'The server refused that request.',
    );
    expect(vaultErrorMessage(new VaultApiError('NOT_FOUND', 'x'))).toBe(
      'This passkey has no key wrap on your account. Log in on a device that already works, then add this one from Settings.',
    );
    expect(vaultErrorMessage(new VaultApiError('CONFLICT', 'x'))).toBe(
      'Another tab or device created this vault first. Log in to it instead of creating a second one.',
    );
    expect(vaultErrorMessage(new VaultApiError('BAD_REQUEST', 'x'))).toBe(
      'The server rejected that request as malformed.',
    );
    expect(vaultErrorMessage(new VaultApiError('PAYLOAD_TOO_LARGE', 'x'))).toBe(
      'That was too large to store.',
    );
    expect(vaultErrorMessage(new VaultApiError('INTERNAL_ERROR', 'x'))).toBe(
      'The server failed on that request. Try again.',
    );
    expect(vaultErrorMessage(new VaultApiError('INVALID_MODE', 'x'))).toBe(
      'This account is not in that login method.',
    );

    expect(vaultErrorMessage(new VaultError('unreadable', 'x'))).toBe(
      'That did not open the vault. In password mode that means the passphrase was wrong; the stored data itself cannot say more than that it failed to authenticate.',
    );
    expect(vaultErrorMessage(new VaultError('malformed', 'x'))).toBe(
      'A stored value was not the shape it should be.',
    );
    expect(vaultErrorMessage(new VaultError('stale', 'x'))).toBe(
      'The server answered with an older version of a record than this device has already seen. Nothing was read.',
    );

    const prfMessage = 'PRF refused on this authenticator.';
    expect(vaultErrorMessage(new PasskeyPrfError(prfMessage))).toBe(prfMessage);

    const unlockMessage =
      'This account already has a password vault. Switch modes to keep it, or reset the vault first — creating one now would mint a new key and strand every existing record.';
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
    expect(vaultErrorMessage(new Error('plain failure'))).toBe('plain failure');
    expect(vaultErrorMessage('thrown string')).toBe('Something failed and gave no reason.');
  });
});
