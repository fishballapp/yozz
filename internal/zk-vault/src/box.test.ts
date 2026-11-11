/** Opens a box with node:crypto to pin its framing, salt order and label, then checks what it refuses. */

import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openBox, openVouched, sealBox, sealVouched } from './box.ts';
import { utf8 } from './bytes.ts';
import { generateKeyPair, importPrivateKey, pairingCode, privateKeyFromBytes } from './x25519.ts';

const INFO = 'test-box';
const AAD = utf8('["project","NAME","1"]');
const MESSAGE = utf8('line one\nline two\n');

/** RFC 7748 §6.1. */
const RFC7748 = {
  alicePrivate: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePublic: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
};

const recipient = async () => {
  const pair = await generateKeyPair();
  const privateKey = await importPrivateKey(pair.privateKey, 'the test key');
  return { pair, privateKey };
};

describe('sealBox / openBox', () => {
  it('opens with the recipient key, and with nothing node:crypto would not derive', async () => {
    const { pair, privateKey } = await recipient();
    const box = await sealBox({
      recipient: privateKey.publicKey,
      info: INFO,
      aad: AAD,
      plaintext: MESSAGE,
    });

    expect(await openBox({ privateKey, info: INFO, aad: AAD, box, what: 'the box' })).toEqual(
      MESSAGE,
    );

    const ephemeral = box.subarray(0, 32);
    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(pair.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeral]),
        format: 'der',
        type: 'spki',
      }),
    });
    const key = Buffer.from(
      hkdfSync('sha256', shared, Buffer.concat([ephemeral, privateKey.publicKey]), INFO, 32),
    );
    const decipher = createDecipheriv('aes-256-gcm', key, box.subarray(32, 44));
    decipher.setAAD(AAD);
    decipher.setAuthTag(box.subarray(-16));

    expect(
      new Uint8Array(Buffer.concat([decipher.update(box.subarray(44, -16)), decipher.final()])),
    ).toEqual(MESSAGE);
  });

  it('seals the same message to a different box every time', async () => {
    const { privateKey } = await recipient();
    const seal = () =>
      sealBox({ recipient: privateKey.publicKey, info: INFO, aad: AAD, plaintext: MESSAGE });

    expect(await seal()).not.toEqual(await seal());
  });

  it('refuses another key, another label, other additional data and a changed byte', async () => {
    const { privateKey } = await recipient();
    const other = await recipient();
    const box = await sealBox({
      recipient: privateKey.publicKey,
      info: INFO,
      aad: AAD,
      plaintext: MESSAGE,
    });
    const open = (
      overrides: Partial<Parameters<typeof openBox>[0]>,
    ): Promise<Uint8Array<ArrayBuffer>> =>
      openBox({ privateKey, info: INFO, aad: AAD, box, what: 'the box', ...overrides });

    await expect(open({ privateKey: other.privateKey })).rejects.toMatchObject({
      code: 'unreadable',
    });
    await expect(open({ info: 'test-other' })).rejects.toMatchObject({ code: 'unreadable' });
    await expect(open({ aad: utf8('["project","OTHER","1"]') })).rejects.toMatchObject({
      code: 'unreadable',
    });
    for (const index of [0, 32, 44, box.length - 1]) {
      const changed = new Uint8Array(box);
      changed[index] = (changed[index] ?? 0) ^ 1;
      await expect(open({ box: changed })).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('refuses what is too short to be a box, and an empty message is still a box', async () => {
    const { privateKey } = await recipient();
    const open = (box: Uint8Array) =>
      openBox({ privateKey, info: INFO, aad: AAD, box, what: 'the box' });

    await expect(open(new Uint8Array(32))).rejects.toMatchObject({ code: 'malformed' });
    await expect(open(new Uint8Array(44))).rejects.toMatchObject({ code: 'malformed' });
    expect(
      await open(
        await sealBox({
          recipient: privateKey.publicKey,
          info: INFO,
          aad: AAD,
          plaintext: new Uint8Array(0),
        }),
      ),
    ).toEqual(new Uint8Array(0));
  });

  it('refuses a low-order recipient key', async () => {
    await expect(
      sealBox({ recipient: new Uint8Array(32), info: INFO, aad: AAD, plaintext: MESSAGE }),
    ).rejects.toMatchObject({ code: 'malformed' });
  });
});

describe('sealVouched / openVouched', () => {
  const vouch = async () => {
    const [sender, reader] = await Promise.all([recipient(), recipient()]);
    const box = await sealVouched({
      sender: sender.privateKey,
      recipient: reader.privateKey.publicKey,
      info: INFO,
      aad: AAD,
      plaintext: MESSAGE,
    });
    return { sender, reader, box };
  };

  it('opens for the recipient under the sender’s public key, as node:crypto derives it', async () => {
    const { sender, reader, box } = await vouch();

    expect(
      await openVouched({
        recipient: reader.privateKey,
        sender: sender.privateKey.publicKey,
        info: INFO,
        aad: AAD,
        box,
        what: 'the proof',
      }),
    ).toEqual(MESSAGE);

    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(reader.pair.privateKey, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b656e032100', 'hex'),
          sender.privateKey.publicKey,
        ]),
        format: 'der',
        type: 'spki',
      }),
    });
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        shared,
        Buffer.concat([sender.privateKey.publicKey, reader.privateKey.publicKey]),
        `vouched:${INFO}`,
        32,
      ),
    );
    const decipher = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(box.subarray(-16));
    expect(
      new Uint8Array(Buffer.concat([decipher.update(box.subarray(12, -16)), decipher.final()])),
    ).toEqual(MESSAGE);
  });

  it('cannot be made by anyone who holds neither private key', async () => {
    const { sender, reader } = await vouch();
    const stranger = await recipient();
    // Anyone can seal an ordinary box to the reader, and a stranger can vouch under their own key.
    const forged = await sealVouched({
      sender: stranger.privateKey,
      recipient: reader.privateKey.publicKey,
      info: INFO,
      aad: AAD,
      plaintext: MESSAGE,
    });

    await expect(
      openVouched({
        recipient: reader.privateKey,
        sender: sender.privateKey.publicKey,
        info: INFO,
        aad: AAD,
        box: forged,
        what: 'the proof',
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('refuses another label, other additional data, a changed byte and the reverse direction', async () => {
    const { sender, reader, box } = await vouch();
    const open = (overrides: Partial<Parameters<typeof openVouched>[0]>) =>
      openVouched({
        recipient: reader.privateKey,
        sender: sender.privateKey.publicKey,
        info: INFO,
        aad: AAD,
        box,
        what: 'the proof',
        ...overrides,
      });
    const changed = new Uint8Array(box);
    changed[20] = (changed[20] ?? 0) ^ 1;

    for (const overrides of [
      { info: 'test-other' },
      { aad: utf8('["other"]') },
      { box: changed },
      // What the sender vouched to the reader is not something the reader vouched to the sender.
      { recipient: sender.privateKey, sender: reader.privateKey.publicKey },
    ]) {
      await expect(open(overrides)).rejects.toMatchObject({ code: 'unreadable' });
    }
  });
});

describe('privateKeyFromBytes', () => {
  it('reads back the public key RFC 7748 publishes for a private one', async () => {
    const { publicKey } = await privateKeyFromBytes(
      Uint8Array.fromHex(RFC7748.alicePrivate),
      'the seed',
    );

    expect(publicKey.toHex()).toBe(RFC7748.alicePublic);
    expect(
      await pairingCode(publicKey.toBase64({ alphabet: 'base64url', omitPadding: true })),
    ).toBe('6069-S5G3');
  });

  it('refuses anything but 32 bytes', async () => {
    await expect(privateKeyFromBytes(new Uint8Array(31), 'the seed')).rejects.toMatchObject({
      code: 'malformed',
    });
  });
});
