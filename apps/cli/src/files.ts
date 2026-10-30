import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';

/**
 * Writes `content` to `file`, owner-only and all or nothing. Its directory is made owner-only (an
 * existing one too); the content goes to a randomly named file beside it, created exclusively at
 * 0600, which is renamed into place. No moment shows it to anyone else, and an interrupted write
 * leaves the old file whole.
 */
export const writePrivateFile = Effect.fn('files.writePrivateFile')(function* (
  file: string,
  content: string | Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const dir = path.dirname(file);
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  yield* fs.chmod(dir, 0o700);
  const suffix = Base64Url.encode(yield* crypto.randomBytes(12));
  const pending = path.join(dir, `.${path.basename(file)}.${suffix}.tmp`);
  const options = { flag: 'wx', mode: 0o600 } as const;
  yield* typeof content === 'string'
    ? fs.writeFileString(pending, content, options)
    : fs.writeFile(pending, content, options);
  yield* fs
    .rename(pending, file)
    .pipe(Effect.onError(() => Effect.ignore(fs.remove(pending, { force: true }))));
});
