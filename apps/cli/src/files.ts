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

const IV_BYTES = 12;

/** `iv ‖ AES-GCM(key, plaintext)`, bound to `additionalData`: every file the CLI keeps sealed is this. */
export const seal = Effect.fn('files.seal')(function* ({
  key,
  additionalData,
  plaintext,
}: {
  readonly key: CryptoKey;
  readonly additionalData: Uint8Array<ArrayBuffer>;
  readonly plaintext: Uint8Array<ArrayBuffer>;
}) {
  const crypto = yield* Crypto.Crypto;
  const iv = new Uint8Array(yield* crypto.randomBytes(IV_BYTES).pipe(Effect.orDie));
  const body = yield* Effect.promise(() =>
    globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext),
  );
  const content = new Uint8Array(IV_BYTES + body.byteLength);
  content.set(iv);
  content.set(new Uint8Array(body), IV_BYTES);
  return content;
});

/** What `seal` sealed, or none when it does not authenticate: another key, another slot, damage. */
export const unseal = ({
  key,
  additionalData,
  content,
}: {
  readonly key: CryptoKey;
  readonly additionalData: Uint8Array<ArrayBuffer>;
  readonly content: Uint8Array;
}) =>
  Effect.tryPromise(() =>
    globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: content.slice(0, IV_BYTES), additionalData },
      key,
      content.slice(IV_BYTES),
    ),
  ).pipe(
    Effect.map(plain => new Uint8Array(plain)),
    Effect.option,
  );
