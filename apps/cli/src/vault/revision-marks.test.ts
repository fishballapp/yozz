import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, layer } from '@effect/vitest';
import { freshVault, type Vault } from '@yozz.app/vault';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { UsageError } from '../errors.ts';
import { fileRevisionMarks } from './revision-marks.ts';

/** A vault whose every record opens at `revision`, so only the marks decide. */
const openingAt = (revision: number): Vault => ({
  recordId: () => Promise.resolve('record_1'),
  encryptRecord: ({ type }) => Promise.resolve({ id: 'record_1', type, ciphertext: 'c' }),
  decryptRecord: () => Promise.resolve({ revision, plaintext: '' }),
  decryptListedRecord: () => Promise.resolve({ revision, plaintext: '', naturalKey: 'k' }),
});

const open = (vault: Vault) =>
  Effect.promise(() =>
    vault.decryptRecord({ type: 'address', naturalKey: 'k', ciphertext: 'c' }).then(
      () => 'opened',
      (error: Error) => error.message,
    ),
  );

layer(NodeServices.layer)(it => {
  describe('file revision marks', () => {
    it.effect('trust a record on first sight, and refuse its replay in a later run', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), 'user_1');

        const firstRun = yield* fileRevisionMarks(dir);
        assert.strictEqual(yield* open(freshVault(openingAt(3), firstRun)), 'opened');

        const laterRun = yield* fileRevisionMarks(dir);
        assert.strictEqual(yield* Effect.promise(() => laterRun.highWaterMark('record_1')), 3);
        assert.strictEqual(
          yield* open(freshVault(openingAt(2), laterRun)),
          'stale: record record_1 is revision 2, behind the 3 this device has already seen',
        );
        assert.strictEqual(yield* open(freshVault(openingAt(3), laterRun)), 'opened');
      }),
    );

    it.effect('count a mark another run raised after this one started', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const runA = yield* fileRevisionMarks(dir);
        const runB = yield* fileRevisionMarks(dir);

        yield* Effect.promise(() => runB.raiseTo('record_1', 5));

        assert.strictEqual(yield* Effect.promise(() => runA.highWaterMark('record_1')), 5);
        assert.strictEqual(
          yield* open(freshVault(openingAt(4), runA)),
          'stale: record record_1 is revision 4, behind the 5 this device has already seen',
        );
      }),
    );

    it.effect('say plainly when the marks cannot be stored, rather than dying', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const readOnly = yield* fs.makeTempDirectoryScoped();
        const dir = path.join(readOnly, 'yozz', 'user_1');
        yield* fs.chmod(readOnly, 0o500);
        yield* Effect.addFinalizer(() => Effect.ignore(fs.chmod(readOnly, 0o700)));
        const marks = yield* fileRevisionMarks(dir);

        const refused = yield* Effect.promise(() =>
          marks.raiseTo('record_1', 1).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        assert.instanceOf(refused, UsageError);
        assert.include(
          (refused as UsageError).message,
          `The revision marks can't be stored at ${dir}`,
        );
        assert.isUndefined(yield* Effect.promise(() => marks.highWaterMark('record_1')));
      }),
    );

    it.effect('never lower a mark, even when another run raised it meanwhile', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const one = yield* fileRevisionMarks(dir);
        const other = yield* fileRevisionMarks(dir);

        yield* Effect.promise(() => other.raiseTo('a', 5));
        yield* Effect.promise(() => one.raiseTo('a', 4));
        yield* Effect.promise(() => one.raiseTo('b', 1));

        const reread = yield* fileRevisionMarks(dir);
        assert.strictEqual(yield* Effect.promise(() => reread.highWaterMark('a')), 5);
        assert.strictEqual(yield* Effect.promise(() => reread.highWaterMark('b')), 1);
      }),
    );
  });
});
