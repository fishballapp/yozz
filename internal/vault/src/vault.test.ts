/**
 * The record store's cryptography.
 *
 * Every test here is a move an untrusted store can make. It holds `id`, `type`
 * and `ciphertext` in the clear and it chooses which row answers a read, so "it
 * round-trips" is the least interesting property in the file — what matters is
 * which rearrangements of those three fields, and which substitutions of whole
 * genuine rows, fail.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { VaultError } from './bytes.ts';
import { type AccountKeys, createDeviceSecret, deriveAccountKeys } from './keys.ts';
import { createVault, openVault, rewrapDek, type Vault } from './vault.ts';

const EMAIL = 'jason@example.com';
const PASSWORD = 'correct horse battery staple';
const DEVICE_SECRET = 'AAECAwQFBgcICQoLDA0ODw';

const ACCOUNT = { email: EMAIL, password: PASSWORD, deviceSecret: DEVICE_SECRET };

/** PBKDF2 at 650,000 iterations is ~0.2s, so derive each distinct account once. */
let keys: AccountKeys;
let other: AccountKeys;
let vault: Vault;
let wrappedDek: string;

beforeAll(async () => {
  [keys, other] = await Promise.all([
    deriveAccountKeys(ACCOUNT),
    deriveAccountKeys({ ...ACCOUNT, email: 'someone@example.com' }),
  ]);
  ({ vault, wrappedDek } = await createVault(keys));
});

/** Enough to break the GCM tag, and total under `noUncheckedIndexedAccess`. */
const flipLastByte = (base64: string): string => {
  const bytes = Uint8Array.fromBase64(base64);
  return bytes.map((byte, index) => (index === bytes.length - 1 ? byte ^ 0x01 : byte)).toBase64();
};

const NATURAL_KEY = 'jason@posteo.de';

const record = (plaintext: string, revision = 1) =>
  vault.encryptRecord({ type: 'account', naturalKey: NATURAL_KEY, revision, plaintext });

/** What the caller asked for, handed whatever the store answered with. */
const read = (v: Vault, ciphertext: string) =>
  v.decryptRecord({ type: 'account', naturalKey: NATURAL_KEY, ciphertext });

/** The plaintext alone, for the tests whose subject is not freshness. */
const readPlaintext = async (v: Vault, ciphertext: string): Promise<string> =>
  (await read(v, ciphertext)).plaintext;

describe('opening a vault', () => {
  it('reopens with the same password and device secret', async () => {
    const reopened = await openVault(await deriveAccountKeys(ACCOUNT), wrappedDek);
    const stored = await record('{"host":"posteo.de","password":"hunter2"}');

    expect(await readPlaintext(reopened, stored.ciphertext)).toBe(
      '{"host":"posteo.de","password":"hunter2"}',
    );
  });

  it('refuses the wrong password and the wrong device secret alike', async () => {
    for (const wrong of [
      { ...ACCOUNT, password: 'correct horse battery stapler' },
      { ...ACCOUNT, deviceSecret: createDeviceSecret() },
    ]) {
      await expect(openVault(await deriveAccountKeys(wrong), wrappedDek)).rejects.toThrow(
        new VaultError('unreadable', 'the wrapped DEK did not authenticate'),
      );
    }
  });

  it('refuses a wrapped DEK that is truncated or not base64', async () => {
    for (const broken of ['', 'not base64!!', wrappedDek.slice(0, 8)]) {
      await expect(openVault(keys, broken)).rejects.toMatchObject({ code: 'malformed' });
    }
  });

  it('refuses a wrapped DEK whose ciphertext was altered', async () => {
    await expect(openVault(keys, flipLastByte(wrappedDek))).rejects.toMatchObject({
      code: 'unreadable',
    });
  });
});

describe('the blind index', () => {
  it('is stable for one natural key and different for every other input', async () => {
    const id = await vault.recordId('account', 'jason@posteo.de');

    expect(await vault.recordId('account', 'jason@posteo.de')).toBe(id);
    expect(await vault.recordId('identity', 'jason@posteo.de')).not.toBe(id);
    expect(await vault.recordId('account', 'jason@gmail.com')).not.toBe(id);
  });

  it('cannot be framed into a collision', async () => {
    // `${type}:${naturalKey}` would give these two the same id, and with it one
    // record's row to the other record's lookup.
    expect(await vault.recordId('account:x', 'y')).not.toBe(await vault.recordId('account', 'x:y'));
  });

  it('differs between two vaults for the same natural key', async () => {
    const theirs = (await createVault(other)).vault;

    expect(await theirs.recordId('account', 'jason@posteo.de')).not.toBe(
      await vault.recordId('account', 'jason@posteo.de'),
    );
  });

  it('reveals nothing about the natural key it came from', async () => {
    const id = await vault.recordId('account', 'jason@posteo.de');

    expect(id).toMatch(/^[\w-]{43}$/);
    expect(id).not.toContain('posteo');
  });
});

describe('a record', () => {
  it('round-trips arbitrary text', async () => {
    for (const plaintext of ['', '{"a":1}', 'ünïcode ✉️ 郵件', 'x'.repeat(100_000)]) {
      expect(await readPlaintext(vault, (await record(plaintext)).ciphertext)).toBe(plaintext);
    }
  });

  it('comes back from a listing with its natural key authenticated', async () => {
    const stored = await vault.encryptRecord({
      type: 'identity',
      naturalKey: 'jason@yozz.app',
      revision: 4,
      plaintext: 'send-only',
    });

    // The enumeration path: the caller fetched rows of a type and knew no
    // natural key going in, so the vault tells it which record this is — and at
    // which revision, which is the one thing a row beside it cannot be believed
    // about.
    expect(await vault.decryptListedRecord('identity', stored)).toEqual({
      revision: 4,
      naturalKey: 'jason@yozz.app',
      plaintext: 'send-only',
    });
  });

  it('cannot answer a listing of one type with a whole record of another', async () => {
    const identity = await vault.encryptRecord({
      type: 'identity',
      naturalKey: 'jason@yozz.app',
      revision: 1,
      plaintext: 'send-only',
    });

    // Genuine row, genuine id, tag intact — and returned to a caller that asked
    // for accounts. The caller knows the TYPE it asked for even when it knows no
    // natural key, so the type is a parameter rather than a field off the row.
    await expect(vault.decryptListedRecord('account', identity)).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('encrypts the same plaintext to different bytes every time', async () => {
    const [first, second] = await Promise.all([record('same'), record('same')]);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await readPlaintext(vault, second.ciphertext)).toBe('same');
  });

  it('reports the revision a superseded ciphertext was written at, not the current one', async () => {
    const before = await record('{"host":"old-host.example"}', 3);
    const after = await record('{"host":"new-host.example"}', 4);

    // The replay itself still OPENS, and it has to: `[id, type]` is identical
    // for every revision of one record, so AES-GCM has nothing to object to.
    // What changed is that the revision is now sealed INSIDE, so the stale read
    // announces itself as 3 while the caller's high-water mark says 4. This
    // package cannot refuse it — refusing needs that mark, which is state it
    // holds none of — so reporting is the whole contract, and a caller that
    // compares is what closes the gap.
    expect(await read(vault, before.ciphertext)).toEqual({
      revision: 3,
      plaintext: '{"host":"old-host.example"}',
    });
    expect(await read(vault, after.ciphertext)).toEqual({
      revision: 4,
      plaintext: '{"host":"new-host.example"}',
    });
  });

  it('round-trips revisions that a string comparison would order wrongly', async () => {
    // `"10" < "9"` as strings, and the freshness check is an ordering. Both
    // survive the tuple as numbers or the defence fails open on the tenth write.
    expect((await read(vault, (await record('x', 9)).ciphertext)).revision).toBe(9);
    expect((await read(vault, (await record('x', 10)).ciphertext)).revision).toBe(10);
    expect((await read(vault, (await record('x', 0)).ciphertext)).revision).toBe(0);
  });

  it('refuses a revision it could not read back, at the door', async () => {
    // A revision that does not round-trip writes a record that never opens
    // again, and the symptom would arrive one fetch later wearing "did not
    // authenticate" — a failure with nothing pointing at its cause.
    for (const revision of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(record('x', revision)).rejects.toMatchObject({ code: 'malformed' });
    }
  });

  it("cannot be answered with another of the vault's OWN records", async () => {
    const substituted = await vault.encryptRecord({
      type: 'account',
      naturalKey: 'jason@gmail.com',
      revision: 1,
      plaintext: '{"password":"someone else\'s"}',
    });

    // The row is entirely genuine — real id, real type, ciphertext that
    // authenticates against them — and this is the substitution an untrusted
    // store can perform for free, by answering one lookup with another row.
    // `decryptRecord` computes the id from what was ASKED FOR, which is the
    // only reason it fails.
    await expect(read(vault, substituted.ciphertext)).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('cannot be listed under an id it was not filed at', async () => {
    const mine = await record('{"password":"hunter2"}');
    const elsewhere = await vault.recordId('account', 'jason@gmail.com');

    await expect(
      vault.decryptListedRecord('account', { ...mine, id: elsewhere }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('cannot be altered a byte', async () => {
    const mine = await record('{"password":"hunter2"}');

    await expect(read(vault, flipLastByte(mine.ciphertext))).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('cannot be read by another vault', async () => {
    const mine = await record('{"password":"hunter2"}');
    const theirs = (await createVault(other)).vault;

    await expect(read(theirs, mine.ciphertext)).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('refuses a ciphertext too short to hold an IV, or not base64', async () => {
    for (const ciphertext of ['', 'not base64!!', new Uint8Array(12).toBase64()]) {
      await expect(read(vault, ciphertext)).rejects.toMatchObject({ code: 'malformed' });
    }
  });
});

describe('rewrapDek', () => {
  it('moves the DEK to a new password without touching a record', async () => {
    const stored = await record('{"password":"hunter2"}');
    const changed = await deriveAccountKeys({ ...ACCOUNT, password: 'a different password' });

    const reopened = await openVault(changed, await rewrapDek(keys, changed, wrappedDek));

    // The point of the DEK: 32 bytes moved, and `stored` was written before the
    // password changed and is read after it.
    expect(await readPlaintext(reopened, stored.ciphertext)).toBe('{"password":"hunter2"}');
  });

  it('leaves every record id exactly where it was', async () => {
    const changed = await deriveAccountKeys({ ...ACCOUNT, password: 'a different password' });
    const reopened = await openVault(changed, await rewrapDek(keys, changed, wrappedDek));

    // The reason `indexKey` hangs off the DEK and not off `masterKey`. Derived
    // from the password, every id would move and re-wrapping 32 bytes would
    // strand the whole store at addresses the new keys cannot compute.
    expect(await reopened.recordId('account', 'jason@posteo.de')).toBe(
      await vault.recordId('account', 'jason@posteo.de'),
    );
  });

  it('refuses to re-wrap under the wrong old keys', async () => {
    await expect(rewrapDek(other, keys, wrappedDek)).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('createVault', () => {
  it('mints a fresh DEK each time, so two vaults never share one', async () => {
    const first = await createVault(keys);
    const second = await createVault(keys);
    const stored = await first.vault.encryptRecord({
      type: 'account',
      naturalKey: 'jason@posteo.de',
      revision: 1,
      plaintext: 'secret',
    });

    // Same encKey, so both wrapped DEKs unwrap — the records must not cross.
    await expect(read(second.vault, stored.ciphertext)).rejects.toMatchObject({
      code: 'unreadable',
    });
  });
});
