/**
 * Everything here was sealed by the code as it stood before the vault moved to `@internal/zk-vault`.
 * A label, salt or framing that changes makes a user's stored vault unreadable, and this is the
 * test that says so.
 */
import { sealCliLogin as sealAnything } from '@internal/zk-vault';
import { describe, expect, it } from 'vitest';
import fixture from './compat.fixture.json' with { type: 'json' };
import {
  deriveAccountKeys,
  deriveCliKeys,
  derivePasskeyEncKey,
  openCliLogin,
  openVault,
  pairingCode,
} from './index.ts';

const passkey = async () => ({
  encKey: await derivePasskeyEncKey(Uint8Array.fromBase64(fixture.prfOutput)),
});

describe('what an earlier build sealed still opens', () => {
  it('opens the vault from the passkey wrap and reads its record and file', async () => {
    const vault = await openVault(await passkey(), fixture.passkeyWrappedDek);
    const { type, naturalKey, revision, plaintext } = fixture.recordPlain;

    expect(await vault.recordId(type, naturalKey)).toBe(fixture.record.id);
    expect(
      await vault.decryptRecord({ type, naturalKey, ciphertext: fixture.record.ciphertext }),
    ).toEqual({ revision, plaintext });
    expect(
      new TextDecoder().decode(
        await vault.decryptFile(fixture.fileId, Uint8Array.fromBase64(fixture.file)),
      ),
    ).toBe(fixture.filePlain);
  });

  it('derives the same password keys', async () => {
    const keys = await deriveAccountKeys(fixture.account);
    const vault = await openVault(keys, fixture.passwordWrappedDek);

    expect(keys.authValue).toBe(fixture.authValue);
    expect(await vault.recordId('mailbox', 'someone@example.com')).toBe(fixture.record.id);
  });

  it('opens the vault and the sealed login with a CLI key', async () => {
    const keys = await deriveCliKeys({
      privateKey: fixture.cliPrivateKey,
      ephemeralPublicKey: fixture.ephemeralPublicKey,
    });
    const vault = await openVault(keys, fixture.cliWrappedDek);

    expect(await vault.recordId('mailbox', 'someone@example.com')).toBe(fixture.record.id);
    expect(
      await openCliLogin(keys.tokenKey, { state: fixture.state, sealedLogin: fixture.sealedLogin }),
    ).toEqual(fixture.login);
    expect(await pairingCode(fixture.cliPublicKey)).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
  });
});

describe('openCliLogin', () => {
  it('refuses what authenticates but is not a login', async () => {
    const { tokenKey } = await deriveCliKeys({
      privateKey: fixture.cliPrivateKey,
      ephemeralPublicKey: fixture.ephemeralPublicKey,
    });

    for (const payload of [
      fixture.login.token,
      { ...fixture.login, token: 'plain' },
      { token: fixture.login.token, userId: fixture.login.userId },
    ]) {
      await expect(
        openCliLogin(tokenKey, {
          state: fixture.state,
          sealedLogin: await sealAnything(tokenKey, { state: fixture.state, payload }),
        }),
      ).rejects.toThrow('the sealed login authenticated but is not a login');
    }
  });
});
