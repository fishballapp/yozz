import { beforeEach, describe, expect, it } from 'vitest';
import { freshVault, inMemoryRevisionMarks, type RevisionMarks } from './fresh.ts';
import { deriveAccountKeys } from './keys.ts';
import { createVault, type Vault } from './vault.ts';

const ACCOUNT = {
  email: 'jason@example.com',
  password: 'correct horse battery staple',
};

const NATURAL_KEY = 'jason@posteo.de';

let inner: Vault;
let marks: RevisionMarks;
let vault: Vault;

beforeEach(async () => {
  inner = (await createVault(await deriveAccountKeys(ACCOUNT))).vault;
  marks = inMemoryRevisionMarks();
  vault = freshVault(inner, marks);
});

const write = (plaintext: string, revision: number) =>
  vault.encryptRecord({ type: 'account', naturalKey: NATURAL_KEY, revision, plaintext });

const read = (ciphertext: string) =>
  vault.decryptRecord({ type: 'account', naturalKey: NATURAL_KEY, ciphertext });

describe('freshVault', () => {
  it('refuses the superseded ciphertext the vault alone would hand back', async () => {
    const before = await write('{"host":"old-host.example"}', 3);
    const after = await write('{"host":"new-host.example"}', 4);

    await expect(read(before.ciphertext)).rejects.toMatchObject({ code: 'stale' });
    expect(await read(after.ciphertext)).toEqual({
      revision: 4,
      plaintext: '{"host":"new-host.example"}',
    });
    expect(
      await inner.decryptRecord({
        type: 'account',
        naturalKey: NATURAL_KEY,
        ciphertext: before.ciphertext,
      }),
    ).toEqual({ revision: 3, plaintext: '{"host":"old-host.example"}' });
  });

  it('advances the mark on a WRITE, or a rotation is undone by a store that ignores it', async () => {
    const before = await write('{"host":"old-host.example"}', 3);
    // The write alone must move the mark, or a store that drops the rotation is believed forever.
    await write('{"host":"new-host.example"}', 4);

    await expect(read(before.ciphertext)).rejects.toMatchObject({ code: 'stale' });
  });

  it('lets a failed write be retried at the same revision', async () => {
    await write('{"host":"new-host.example"}', 4);

    const retried = await write('{"host":"new-host.example"}', 4);
    expect(await read(retried.ciphertext)).toEqual({
      revision: 4,
      plaintext: '{"host":"new-host.example"}',
    });
  });

  it('refuses a write that goes backwards', async () => {
    await write('{"host":"new-host.example"}', 4);

    await expect(write('{"host":"old-host.example"}', 3)).rejects.toMatchObject({ code: 'stale' });
  });

  it('trusts the first sight of a record it has no mark for', async () => {
    const stored = await write('{"host":"posteo.de"}', 9);
    const freshDevice = freshVault(inner, inMemoryRevisionMarks());

    expect(
      await freshDevice.decryptRecord({
        type: 'account',
        naturalKey: NATURAL_KEY,
        ciphertext: stored.ciphertext,
      }),
    ).toEqual({ revision: 9, plaintext: '{"host":"posteo.de"}' });
  });

  it('checks the enumeration path too, under the id the listing supplied', async () => {
    const before = await write('{"host":"old-host.example"}', 3);
    await write('{"host":"new-host.example"}', 4);

    await expect(vault.decryptListedRecord('account', before)).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('marks records independently, so one rotation does not strand another', async () => {
    await vault.encryptRecord({
      type: 'account',
      naturalKey: 'jason@gmail.com',
      revision: 12,
      plaintext: 'busy',
    });
    const quiet = await write('{"host":"posteo.de"}', 1);

    expect(await read(quiet.ciphertext)).toEqual({
      revision: 1,
      plaintext: '{"host":"posteo.de"}',
    });
  });

  it('returns the inner failure untouched rather than a freshness verdict', async () => {
    const substituted = await inner.encryptRecord({
      type: 'account',
      naturalKey: 'someone-else@gmail.com',
      revision: 99,
      plaintext: 'not yours',
    });

    await expect(read(substituted.ciphertext)).rejects.toMatchObject({ code: 'unreadable' });
    expect(
      await marks.highWaterMark(await vault.recordId('account', 'someone-else@gmail.com')),
    ).toBe(undefined);
  });

  it('calls raiseTo only upward, so a covered revision costs no write', async () => {
    const advanced: number[] = [];
    const underlying = inMemoryRevisionMarks();
    const recording = freshVault(inner, {
      highWaterMark: underlying.highWaterMark,
      raiseTo: async (id, revision) => {
        advanced.push(revision);
        await underlying.raiseTo(id, revision);
      },
    });
    const seal = (revision: number) =>
      recording.encryptRecord({
        type: 'account',
        naturalKey: NATURAL_KEY,
        revision,
        plaintext: 'x',
      });

    await seal(5);
    await seal(5);
    const current = await seal(6);
    await recording.decryptRecord({
      type: 'account',
      naturalKey: NATURAL_KEY,
      ciphertext: current.ciphertext,
    });

    expect(advanced).toEqual([5, 6]);
  });

  it('never lowers a mark, which is the whole of what raiseTo promises', async () => {
    const marks = inMemoryRevisionMarks();

    // Deterministic rather than a microtask race: this invariant holds regardless of who lands last.
    await marks.raiseTo('a-record-id', 9);
    await marks.raiseTo('a-record-id', 8);

    expect(await marks.highWaterMark('a-record-id')).toBe(9);
  });
});
