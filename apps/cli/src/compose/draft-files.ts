import type { Attachment } from '@yozz.app/mail/threads/thread';
import * as Context from 'effect/Context';
import type * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { UsageError } from '../errors.ts';
import { seal, unseal, writePrivateFile } from '../files.ts';
import { Settings } from '../settings.ts';
import { Vault } from '../vault/vault.ts';

// A vault record holds at most 1 MB, and the web composer keeps its files in memory, so a draft's
// record names no attachments. The files `yozz draft` attached (or a forward carried) stay on this
// machine instead, one sealed file per draft, until the draft is sent or discarded.

const FileSchema = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Int,
      kind: Schema.Literals(['pdf', 'image', 'archive', 'sheet', 'other']),
      mimeType: Schema.optionalKey(Schema.String),
      content: Schema.Uint8ArrayFromBase64,
    }),
  ),
});
const FileJson = Schema.fromJsonString(FileSchema);

export class DraftFiles extends Context.Service<
  DraftFiles,
  {
    /** The files kept for the draft; none when it has none. */
    readonly read: (draftKey: string) => Effect.Effect<readonly Attachment[], UsageError>;
    /** Replaces the draft's files; an empty list deletes them. */
    readonly write: (
      draftKey: string,
      attachments: readonly Attachment[],
    ) => Effect.Effect<void, UsageError>;
  }
>()('@yozz.app/cli/DraftFiles') {
  /** `$XDG_STATE_HOME/yozz/<userId>/drafts/`, sealed under the vault's local key, so `logout` deletes them. */
  static readonly layer = Layer.effect(
    DraftFiles,
    Effect.gen(function* () {
      const vault = yield* Vault;
      const settings = yield* Settings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
      const dir = path.join(settings.stateDir(vault.account.userId), 'drafts');
      const unusable =
        (verb: string) =>
        ({ message }: { readonly message: string }) =>
          new UsageError({
            message: `A draft's attachments can't be ${verb} at ${dir}: ${message}`,
          });

      /** Named by a digest: a draft key comes from the vault, and need not be a safe file name. */
      const fileOf = (draftKey: string) =>
        Effect.promise(() =>
          crypto.subtle.digest('SHA-256', new TextEncoder().encode(draftKey)),
        ).pipe(Effect.map(digest => path.join(dir, `${new Uint8Array(digest).toHex()}.bin`)));
      const additionalData = (draftKey: string) =>
        new TextEncoder().encode(JSON.stringify(['yozz-cli-draft-files', draftKey]));

      return DraftFiles.of({
        read: Effect.fn('DraftFiles.read')(function* (draftKey) {
          const file = yield* fileOf(draftKey);
          const content = yield* fs.readFile(file).pipe(
            Effect.asSome,
            Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
            Effect.mapError(unusable('read')),
          );
          if (Option.isNone(content)) return [];
          const opened = yield* unseal({
            key: vault.cacheKey,
            additionalData: additionalData(draftKey),
            content: content.value,
          }).pipe(
            Effect.flatMap(plain =>
              Option.isNone(plain)
                ? Effect.succeedNone
                : Schema.decodeEffect(FileJson)(new TextDecoder().decode(plain.value)).pipe(
                    Effect.option,
                  ),
            ),
          );
          // Sending without them would send something other than the draft printed.
          if (Option.isNone(opened)) {
            return yield* new UsageError({
              message: `The attachments kept for this draft at ${file} don't open; discard it and draft it again`,
            });
          }
          return opened.value.attachments.map(({ content, ...attachment }) => ({
            ...attachment,
            content: new Uint8Array(content),
          }));
        }, Effect.provideContext(context)),
        write: Effect.fn('DraftFiles.write')(function* (draftKey, attachments) {
          const file = yield* fileOf(draftKey);
          if (attachments.length === 0) {
            return yield* fs
              .remove(file, { force: true })
              .pipe(Effect.mapError(unusable('deleted')));
          }
          const json = yield* Schema.encodeEffect(FileJson)({
            attachments: attachments.map(({ content, ...attachment }) => {
              if (content === undefined) throw new Error(`${attachment.name} has no bytes to keep`);
              return { ...attachment, content };
            }),
          }).pipe(Effect.orDie);
          const sealed = yield* seal({
            key: vault.cacheKey,
            additionalData: additionalData(draftKey),
            plaintext: new TextEncoder().encode(json),
          });
          yield* writePrivateFile(file, sealed).pipe(Effect.mapError(unusable('written')));
        }, Effect.provideContext(context)),
      });
    }),
  );
}
