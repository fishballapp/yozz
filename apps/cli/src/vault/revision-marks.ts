import type { RevisionMarks } from '@yozz.app/vault';
import type * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import { UsageError, VaultUnreadable } from '../errors.ts';
import { writePrivateFile } from '../files.ts';

const MarksJsonSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
);

/**
 * This machine's high-water mark per record id, in `<dir>/revision-marks.json`: the rollback
 * defence, trust on first use for a record not seen yet. The file is the only copy, read on every
 * question, so a mark another `yozz` run raised meanwhile counts at once. A raise re-reads it, keeps
 * the higher mark and lands by rename, so a mark is never lowered and a crash leaves the old file
 * whole. The promises reject with the CLI's own errors.
 *
 * ponytail: two runs raising at the same instant can still lose one raise between the re-read and
 * the rename (a lock file would close it). The lost mark falls back to trust on first use for that
 * record, which a replay must then also hit; un-park if marks are ever seen to drop.
 */
export const fileRevisionMarks = Effect.fn('vault.fileRevisionMarks')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, 'revision-marks.json');

  const read = fs.readFileString(file).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed('{}')),
    Effect.flatMap(Schema.decodeUnknownEffect(MarksJsonSchema)),
    Effect.mapError(
      () =>
        new VaultUnreadable({
          message: `The revision marks are unreadable (delete them to trust the server's records again): ${file}`,
        }),
    ),
  );
  // Read once up front, so a corrupt file fails before the vault is used.
  yield* read;
  const writing = yield* Semaphore.make(1);
  const run = Effect.runPromiseWith(
    yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>(),
  );

  const raise = (id: string, revision: number) =>
    Effect.gen(function* () {
      const onDisk = yield* read;
      const text = yield* Schema.encodeEffect(MarksJsonSchema)({
        ...onDisk,
        [id]: Math.max(onDisk[id] ?? revision, revision),
      }).pipe(Effect.orDie);
      yield* writePrivateFile(file, text).pipe(
        Effect.mapError(
          ({ message }) =>
            new UsageError({ message: `The revision marks can't be stored at ${dir}: ${message}` }),
        ),
      );
    }).pipe(Semaphore.withPermit(writing));

  return {
    highWaterMark: id => run(Effect.map(read, marks => marks[id])),
    raiseTo: (id, revision) => run(raise(id, revision)),
  } satisfies RevisionMarks;
});
