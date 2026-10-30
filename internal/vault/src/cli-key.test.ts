/** Re-derives the CLI key schedule with node:crypto, from RFC 7748's published vector and from live pairs, to pin the salt, its order, both info labels and the login's additional data. */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { VaultError } from './bytes.ts';
import {
  deriveApprovalKeys,
  deriveCliKeys,
  generateCliKeyPair,
  openCliLogin,
  pairingCode,
  sealCliLogin,
} from './cli-key.ts';
import { type AccountKeys, deriveAccountKeys } from './keys.ts';
import { createVault, openVault, rewrapDek } from './vault.ts';

/** RFC 7748 §6.1. */
const RFC7748 = {
  alicePrivate: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePublic: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  bobPublic: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  shared: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
};

/** RFC 8410's PKCS #8 prefix for a raw X25519 private key. */
const PKCS8_X25519_PREFIX = '302e020100300506032b656e04220420';

const base64Url = (hex: string): string => Buffer.from(hex, 'hex').toString('base64url');

const LOGIN = {
  token: `yozzcli_0f8fad5b-d9cb-469f-a165-70867728950e_${'A'.repeat(43)}`,
  userId: 'user-1',
  email: 'jason@example.com',
};

const STATE = 'S'.repeat(43);

/** HKDF-SHA256 the way RFC 5869 states it, with the schedule's salt and labels spelled out here. */
const controlKeys = (shared: Buffer, ephemeral: Buffer, cli: Buffer) => {
  const salt = Buffer.concat([ephemeral, cli]);
  return {
    encKey: Buffer.from(hkdfSync('sha256', shared, salt, 'yozz-vault-cli-key', 32)),
    tokenKey: Buffer.from(hkdfSync('sha256', shared, salt, 'yozz-cli-token', 32)),
  };
};

/** AES-256-GCM the way WebCrypto lays it out: `iv ‖ ciphertext ‖ tag`, base64. */
const controlOpen = (sealedText: string, key: Buffer, additionalData?: string): Buffer => {
  const sealed = Buffer.from(sealedText, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  if (additionalData !== undefined) decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  return Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]);
};

const controlSeal = (plaintext: string, key: Buffer, additionalData: string): string => {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
};

const flipLastByte = (base64: string): string => {
  const bytes = Uint8Array.fromBase64(base64);
  return bytes.map((byte, index) => (index === bytes.length - 1 ? byte ^ 0x01 : byte)).toBase64();
};

let account: AccountKeys;
let wrappedDek: string;

beforeAll(async () => {
  account = await deriveAccountKeys({ email: 'jason@example.com', password: 'correct horse' });
  ({ wrappedDek } = await createVault(account));
});

/** One approval: the browser wraps the DEK it holds to a fresh CLI key. */
const approve = async () => {
  const cliKey = await generateCliKeyPair();
  const approval = await deriveApprovalKeys(cliKey.publicKey);
  return {
    cliKey,
    approval,
    wrap: await rewrapDek(account, approval, wrappedDek),
    sealedLogin: await sealCliLogin(approval.tokenKey, { state: STATE, payload: LOGIN }),
  };
};

describe('the CLI key schedule', () => {
  it('derives from RFC 7748’s vector the keys node:crypto derives', async () => {
    // Alice is the CLI, Bob the approving browser's ephemeral pair.
    const control = controlKeys(
      Buffer.from(RFC7748.shared, 'hex'),
      Buffer.from(RFC7748.bobPublic, 'hex'),
      Buffer.from(RFC7748.alicePublic, 'hex'),
    );

    const keys = await deriveCliKeys({
      privateKey: base64Url(PKCS8_X25519_PREFIX + RFC7748.alicePrivate),
      ephemeralPublicKey: base64Url(RFC7748.bobPublic),
    });

    expect(
      await openCliLogin(keys.tokenKey, {
        state: STATE,
        sealedLogin: controlSeal(JSON.stringify(LOGIN), control.tokenKey, STATE),
      }),
    ).toEqual(LOGIN);
    const dek = controlOpen(await rewrapDek(account, keys, wrappedDek), control.encKey);
    expect(dek).toHaveLength(32);
  });

  it('derives on the approving side the keys node:crypto derives from the CLI’s private key', async () => {
    const { cliKey, approval, wrap, sealedLogin } = await approve();

    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(cliKey.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      }),
      publicKey: createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: approval.ephemeralPublicKey },
        format: 'jwk',
      }),
    });
    const control = controlKeys(
      shared,
      Buffer.from(approval.ephemeralPublicKey, 'base64url'),
      Buffer.from(cliKey.publicKey, 'base64url'),
    );

    expect(JSON.parse(controlOpen(sealedLogin, control.tokenKey, STATE).toString('utf8'))).toEqual(
      LOGIN,
    );
    expect(controlOpen(wrap, control.encKey)).toHaveLength(32);
  });

  it('opens, from the CLI’s side, the vault a browser wrapped to it', async () => {
    const vault = await openVault(account, wrappedDek);
    const record = await vault.encryptRecord({
      type: 'address',
      naturalKey: 'jason@posteo.de',
      revision: 1,
      plaintext: '{"password":"hunter2"}',
    });
    const { cliKey, approval, wrap, sealedLogin } = await approve();

    const keys = await deriveCliKeys({
      privateKey: cliKey.privateKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
    });

    expect(await openCliLogin(keys.tokenKey, { state: STATE, sealedLogin })).toEqual(LOGIN);
    const opened = await openVault(keys, wrap);
    expect(
      await opened.decryptRecord({
        type: 'address',
        naturalKey: 'jason@posteo.de',
        ciphertext: record.ciphertext,
      }),
    ).toEqual({ revision: 1, plaintext: '{"password":"hunter2"}' });
  });

  it('does not open for any other CLI key, even with the same ephemeral key', async () => {
    const { approval, wrap, sealedLogin } = await approve();
    const stranger = await generateCliKeyPair();

    const keys = await deriveCliKeys({
      privateKey: stranger.privateKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
    });

    await expect(openVault(keys, wrap)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(openCliLogin(keys.tokenKey, { state: STATE, sealedLogin })).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('does not open with another ephemeral key', async () => {
    const { cliKey, wrap, sealedLogin } = await approve();
    const other = await deriveApprovalKeys(cliKey.publicKey);

    const keys = await deriveCliKeys({
      privateKey: cliKey.privateKey,
      ephemeralPublicKey: other.ephemeralPublicKey,
    });

    await expect(openVault(keys, wrap)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(openCliLogin(keys.tokenKey, { state: STATE, sealedLogin })).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('refuses a sealed login that was altered, or opened for another login', async () => {
    const { cliKey, approval, sealedLogin } = await approve();
    const keys = await deriveCliKeys({
      privateKey: cliKey.privateKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
    });

    await expect(
      openCliLogin(keys.tokenKey, { state: STATE, sealedLogin: flipLastByte(sealedLogin) }),
    ).rejects.toThrow(new VaultError('unreadable', 'the sealed login did not authenticate'));
    await expect(
      openCliLogin(keys.tokenKey, { state: 'T'.repeat(43), sealedLogin }),
    ).rejects.toThrow(new VaultError('unreadable', 'the sealed login did not authenticate'));
    await expect(
      openCliLogin(keys.tokenKey, { state: STATE, sealedLogin: sealedLogin.slice(0, 12) }),
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it('refuses a login that authenticates but is not a login', async () => {
    const shared = Buffer.from(RFC7748.shared, 'hex');
    const control = controlKeys(
      shared,
      Buffer.from(RFC7748.bobPublic, 'hex'),
      Buffer.from(RFC7748.alicePublic, 'hex'),
    );
    const keys = await deriveCliKeys({
      privateKey: base64Url(PKCS8_X25519_PREFIX + RFC7748.alicePrivate),
      ephemeralPublicKey: base64Url(RFC7748.bobPublic),
    });

    for (const plaintext of [
      'not json',
      JSON.stringify(LOGIN.token),
      JSON.stringify({ ...LOGIN, token: 'plain' }),
      JSON.stringify({ token: LOGIN.token, userId: LOGIN.userId }),
    ]) {
      await expect(
        openCliLogin(keys.tokenKey, {
          state: STATE,
          sealedLogin: controlSeal(plaintext, control.tokenKey, STATE),
        }),
      ).rejects.toThrow(
        new VaultError('unreadable', 'the sealed login authenticated but is not a login'),
      );
    }
  });

  it('seals each login under a fresh IV', async () => {
    const { approval } = await approve();

    expect(await sealCliLogin(approval.tokenKey, { state: STATE, payload: LOGIN })).not.toBe(
      await sealCliLogin(approval.tokenKey, { state: STATE, payload: LOGIN }),
    );
  });

  it('derives keys that never leave WebCrypto, each for its one job', async () => {
    const { cliKey, approval } = await approve();
    const cli = await deriveCliKeys({
      privateKey: cliKey.privateKey,
      ephemeralPublicKey: approval.ephemeralPublicKey,
    });

    for (const keys of [approval, cli]) {
      expect(keys.encKey.extractable).toBe(false);
      expect(keys.encKey.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
      expect(keys.encKey.usages.toSorted()).toEqual(['unwrapKey', 'wrapKey']);
      expect(keys.tokenKey.extractable).toBe(false);
      expect(keys.tokenKey.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
      expect(keys.tokenKey.usages.toSorted()).toEqual(['decrypt', 'encrypt']);
    }
  });

  it('refuses a low-order public key, which would make the secret zero', async () => {
    const zero = base64Url('00'.repeat(32));
    const { privateKey } = await generateCliKeyPair();

    await expect(deriveApprovalKeys(zero)).rejects.toMatchObject({ code: 'malformed' });
    await expect(deriveCliKeys({ privateKey, ephemeralPublicKey: zero })).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('refuses a public key that is not 32 bytes, or a private key that is not X25519', async () => {
    const { privateKey, publicKey } = await generateCliKeyPair();

    await expect(deriveApprovalKeys(publicKey.slice(0, 40))).rejects.toMatchObject({
      code: 'malformed',
    });
    await expect(
      deriveCliKeys({ privateKey: publicKey, ephemeralPublicKey: publicKey }),
    ).rejects.toMatchObject({ code: 'malformed' });
    await expect(
      deriveCliKeys({ privateKey, ephemeralPublicKey: `${publicKey}AA` }),
    ).rejects.toMatchObject({ code: 'malformed' });
  });
});

describe('pairingCode', () => {
  it('is the first 40 bits of SHA-256 of the public key, in Crockford base32', async () => {
    // SHA-256 of RFC 7748's Alice public key begins 30 0c 9c 96 03.
    expect(await pairingCode(base64Url(RFC7748.alicePublic))).toBe('6069-S5G3');
  });

  it('differs between two keys', async () => {
    const [one, two] = await Promise.all([generateCliKeyPair(), generateCliKeyPair()]);

    expect(await pairingCode(one.publicKey)).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(await pairingCode(one.publicKey)).not.toBe(await pairingCode(two.publicKey));
  });
});
