import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { UsageError } from '../errors.ts';
import { untrusted } from './rows.ts';

/**
 * Room for any real name, and for the ` (1000)` a taken one may gain, short of every file system's
 * 255-byte limit.
 */
const MAX_NAME_BYTES = 192;
/** How many ` (n)` variants a taken name tries before giving up. */
const MAX_VARIANTS = 1000;

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The longest start of `text` within `max` UTF-8 bytes, cut between code points. */
const withinBytes = (text: string, max: number) => {
  const kept: string[] = [];
  let used = 0;
  for (const point of text) {
    used += bytesOf(point);
    if (used > max) break;
    kept.push(point);
  }
  return kept.join('');
};

/**
 * An attachment's name, which is mail content, as a bare file name: its last path segment, without
 * controls or bidirectional overrides, separators, leading dots (so no `..` and nothing hidden) or
 * trailing dots and spaces, within `MAX_NAME_BYTES` with its extension kept.
 */
export const safeFileName = (name: string): string => {
  const segment = untrusted(name.normalize('NFC'))
    .replace(/[\n\t]/gu, ' ')
    .split(/[/\\]/u)
    .at(-1);
  const trimmed = (text: string) => text.replace(/^[.\s]+|[.\s]+$/gu, '');
  const bare = trimmed((segment ?? '').replace(/:/gu, '_'));
  if (bare === '') return 'attachment';
  if (bytesOf(bare) <= MAX_NAME_BYTES) return bare;
  const dot = bare.lastIndexOf('.');
  const extension = dot > 0 && bare.length - dot <= 16 ? bare.slice(dot) : '';
  const stem = withinBytes(
    bare.slice(0, bare.length - extension.length),
    MAX_NAME_BYTES - bytesOf(extension),
  );
  return `${trimmed(stem) || 'attachment'}${extension}`;
};

/** `name (2).pdf` for the second file of that name. */
const variant = (name: string, n: number) => {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

/**
 * Writes `content` into `dir` under the attachment's safe name, owner-only, never over a file that
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
  const safe = safeFileName(name);
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
