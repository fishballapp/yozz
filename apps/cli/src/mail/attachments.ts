import { savedName } from '@yozz.app/mail/threads/attachment-content';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { UsageError } from '../errors.ts';

/** How many ` (n)` variants a taken name tries before giving up. */
const MAX_VARIANTS = 1000;

/** `name (2).pdf` for the second file of that name. */
const variant = (name: string, n: number) => {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

/**
 * Writes `content` into `dir` under the attachment's saved name (`savedName`, the name its notes
 * read and yozz.app shows), owner-only, never over a file that
 * is there (created exclusively, so not through a link either): a taken name gets ` (2)`, ` (3)`….
 * Answers the path written.
 */
export const saveAttachment = Effect.fn('mail.saveAttachment')(function* (
  dir: string,
  name: string,
  content: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safe = savedName(name);
  const attempt = (n: number): Effect.Effect<string, UsageError> => {
    const file = path.join(dir, variant(safe, n));
    if (n > MAX_VARIANTS) {
      return Effect.fail(new UsageError({ message: `Too many files named ${safe} in ${dir}` }));
    }
    return fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }).pipe(
      Effect.as(file),
      Effect.catchReason('PlatformError', 'AlreadyExists', () => attempt(n + 1)),
      Effect.mapError(
        ({ message }) =>
          new UsageError({ message: `Can't save attachments in ${dir}: ${message}` }),
      ),
    );
  };
  return yield* attempt(1);
});
