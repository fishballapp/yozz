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

    // The whole point. `inner` opens this happily — it is a genuine record at a
    // genuine id — and the mark is what makes it a refusal.
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
    // Nothing has READ revision 4 — the write alone must move the mark, or a
    // store that silently drops the rotation keeps serving 3 forever and the
    // credential the user rotated away from stays live.
    await write('{"host":"new-host.example"}', 4);

    await expect(read(before.ciphertext)).rejects.toMatchObject({ code: 'stale' });
  });

  it('lets a failed write be retried at the same revision', async () => {
    await write('{"host":"new-host.example"}', 4);

    // The store never took it. Re-sealing the same revision must pass: the
    // check refuses only what is BELOW the mark, so equality is the retry path.
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

    // TOFU, and the accepted limit: a device with no mark has nothing to
    // compare against, so revision 9 is taken on sight and becomes the floor.
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

    // A per-VAULT mark would refuse this: revision 1 is far behind the 12 the
    // other record reached. The mark is per record id, and this is the test
    // that says so.
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

    // Ordering: the inner read runs first, so a record that does not
    // authenticate is `unreadable` and never reaches the mark. A wrapper that
    // checked freshness first could advance a mark from a row the vault was
    // about to reject.
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

    // 5 then 6, and neither the equal re-seal nor the read back at 6 calls it
    // again. This is IO avoidance rather than the safety property — `raiseTo`
    // is a max, so an interleaved call at 5 after 6 would be harmless anyway.
    expect(advanced).toEqual([5, 6]);
  });

  it('never lowers a mark, which is the whole of what raiseTo promises', async () => {
    const marks = inMemoryRevisionMarks();

    // Deterministic on purpose. The motivating scenario is two same-id writes
    // overlapping — both snapshot the mark before either write lands, both pass
    // the staleness test, and the lower one can land last; measured at 9 then 8
    // with a blind `set`. Reproducing that interleaving in a test means racing
    // microtasks, and the ordering flips with any await added upstream, so the
    // test would pass for the wrong reason as often as the right one. The
    // invariant that actually has to hold is this one, and it holds regardless
    // of who lands last.
    await marks.raiseTo('a-record-id', 9);
    await marks.raiseTo('a-record-id', 8);

    expect(await marks.highWaterMark('a-record-id')).toBe(9);
  });
});
