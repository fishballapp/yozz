import type { ImapMessageSummary } from '@yozz.app/imap';
import type { FetchedBody } from '@yozz.app/mail/threads/bodies';
import type { FolderCache, FolderSync, MailCache } from '@yozz.app/mail/threads/cache';
import { FOLDERS, type Folder } from '@yozz.app/mail/threads/thread';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import { UsageError } from '../errors.ts';
import { writePrivateFile } from '../files.ts';

// One account's mail cache on disk: a file per folder (its sync mark, summaries and previews), a
// file per cached body named for its folder's UIDVALIDITY, and when the account last synced. Each is `iv ‖ AES-GCM(key, JSON)` with the account and the file's name as
// additional data, so a file moved to another slot does not open. One that does not open, or no
// longer decodes, is deleted and read as absent, and the next sync rebuilds it. A file the disk
// will not read or write is the person's to fix: a `UsageError`, never a defect.
//
// ponytail: two `yozz` runs syncing one account at once each write whole files, so the last one
// wins a folder and the other's newest mail is fetched again by the next sync. Un-park if a cache is
// ever seen to lose mail for good.

const NullableString = Schema.NullOr(Schema.String);

const AddressSchema = Schema.Struct({
  name: NullableString,
  mailbox: NullableString,
  host: NullableString,
});

const SummarySchema = Schema.Struct({
  seq: Schema.Int,
  uid: Schema.Int,
  flags: Schema.Array(Schema.String),
  internalDate: NullableString,
  size: Schema.NullOr(Schema.Int),
  envelope: Schema.NullOr(
    Schema.Struct({
      date: NullableString,
      subject: NullableString,
      subjectRaw: NullableString,
      from: Schema.Array(AddressSchema),
      sender: Schema.Array(AddressSchema),
      replyTo: Schema.Array(AddressSchema),
      to: Schema.Array(AddressSchema),
      cc: Schema.Array(AddressSchema),
      bcc: Schema.Array(AddressSchema),
      inReplyTo: NullableString,
      messageId: NullableString,
    }),
  ),
  references: Schema.Array(Schema.String),
  gmailThreadId: NullableString,
});

const FolderFileSchema = Schema.Struct({
  sync: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      uidValidity: Schema.Int,
      lastUid: Schema.Int,
      complete: Schema.Boolean,
    }),
  ),
  summaries: Schema.Array(SummarySchema),
  /** The text of each cached body, so the list has excerpts without reading every body. */
  previews: Schema.Array(
    Schema.Struct({ uid: Schema.Int, paragraphs: Schema.Array(Schema.String) }),
  ),
});
type FolderFile = typeof FolderFileSchema.Type;

const BodySchema = Schema.Struct({
  paragraphs: Schema.Array(Schema.String),
  hasTextPart: Schema.Boolean,
  html: Schema.optionalKey(Schema.String),
  inlineImagesTruncated: Schema.Boolean,
  attachments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Int,
      kind: Schema.Literals(['pdf', 'image', 'archive', 'sheet', 'other']),
      mimeType: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.Uint8ArrayFromBase64),
    }),
  ),
  senderHeaders: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
});

const AccountFileSchema = Schema.Struct({
  /** When the account's last sync that landed started, in epoch milliseconds. */
  syncedAt: Schema.Int,
});

const FolderJson = Schema.fromJsonString(FolderFileSchema);
const BodyJson = Schema.fromJsonString(BodySchema);
const AccountJson = Schema.fromJsonString(AccountFileSchema);

const EMPTY_FOLDER: FolderFile = { sync: null, summaries: [], previews: [] };

/** The parsed body, with the mutable arrays and `ArrayBuffer`-backed bytes the mail package uses. */
const asFetchedBody = (body: typeof BodySchema.Type): FetchedBody => ({
  ...body,
  paragraphs: [...body.paragraphs],
  attachments: body.attachments.map(({ content, ...attachment }) => ({
    ...attachment,
    ...(content === undefined ? {} : { content: new Uint8Array(content) }),
  })),
});

const IV_BYTES = 12;

/** The mail-cache promises reject with the CLI's own `UsageError`; anything else is a fault. */
export const usingCache = <A>(thunk: () => Promise<A>): Effect.Effect<A, UsageError> =>
  Effect.tryPromise(thunk).pipe(
    Effect.catchTag('UnknownError', ({ cause }) =>
      cause instanceof UsageError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );

/** One account's cache under `dir`, sealed with `key`. */
export const accountCache = Effect.fn('cache.accountCache')(function* ({
  dir,
  key,
  account,
}: {
  readonly dir: string;
  readonly key: CryptoKey;
  readonly account: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
  const run = Effect.runPromiseWith(context);
  const additionalData = (name: string) =>
    new TextEncoder().encode(JSON.stringify(['yozz-cli-cache', account, name]));
  const unusable =
    (verb: string) =>
    ({ message }: { readonly message: string }) =>
      new UsageError({ message: `The mail cache can't be ${verb} at ${dir}: ${message}` });

  /** A file of this account's failed to open this run, so what the cache holds is not what synced. */
  let isDamaged = false;

  /** What `name` holds, or none when it is missing, does not open, or no longer decodes. */
  const read = <A>(name: string, codec: Schema.Codec<A, string>) =>
    Effect.gen(function* () {
      const file = path.join(dir, name);
      const bytes = yield* fs.readFile(file).pipe(
        Effect.asSome,
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
        Effect.mapError(unusable('read')),
      );
      if (Option.isNone(bytes)) return Option.none<A>();
      const opened = yield* Effect.tryPromise(() =>
        globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bytes.value.slice(0, IV_BYTES),
            additionalData: additionalData(name),
          },
          key,
          bytes.value.slice(IV_BYTES),
        ),
      ).pipe(
        Effect.map(plain => new TextDecoder().decode(plain)),
        Effect.flatMap(Schema.decodeEffect(codec)),
        Effect.option,
      );
      if (Option.isNone(opened)) {
        // A body is only fetched again; a folder's file held what the sync read.
        if (!name.startsWith('bodies')) isDamaged = true;
        yield* fs.remove(file, { force: true }).pipe(Effect.mapError(unusable('written')));
      }
      return opened;
    });

  const write = <A>(name: string, codec: Schema.Codec<A, string>, value: A) =>
    Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(codec)(value).pipe(Effect.orDie);
      const iv = new Uint8Array(yield* crypto.randomBytes(IV_BYTES).pipe(Effect.orDie));
      const sealed = yield* Effect.promise(() =>
        globalThis.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: additionalData(name) },
          key,
          new TextEncoder().encode(json),
        ),
      );
      const content = new Uint8Array(IV_BYTES + sealed.byteLength);
      content.set(iv);
      content.set(new Uint8Array(sealed), IV_BYTES);
      yield* writePrivateFile(path.join(dir, name), content).pipe(
        Effect.mapError(unusable('written')),
      );
    });

  const folderCache = (folder: Folder) => {
    const name = `${folder}.bin`;
    const lock = Semaphore.makeUnsafe(1);
    /** The file as this run last read or wrote it; a lazy cache is the point. */
    let held: FolderFile | null = null;
    const current = Effect.suspend(() => {
      if (held !== null) return Effect.succeed(held);
      return read(name, FolderJson).pipe(
        Effect.map(file => Option.getOrElse(file, () => EMPTY_FOLDER)),
        Effect.tap(file =>
          Effect.sync(() => {
            held = file;
          }),
        ),
      );
    });
    const update = (change: (file: FolderFile) => FolderFile) =>
      run(
        Effect.gen(function* () {
          const next = change(yield* current);
          yield* write(name, FolderJson, next);
          held = next;
        }).pipe(lock.withPermits(1)),
      );
    /** A uid names a body only under the UIDVALIDITY it was read under. */
    const bodyName = (uidValidity: number, uid: number) =>
      path.join('bodies', `${folder}-${uidValidity}-${uid}.bin`);

    const cache: FolderCache = {
      getSync: () => run(Effect.map(current, ({ sync }): FolderSync | null => sync)),
      putSync: sync => update(file => ({ ...file, sync })),
      listSummaries: () =>
        run(Effect.map(current, ({ summaries }): readonly ImapMessageSummary[] => summaries)),
      putSummaries: summaries =>
        update(file => {
          const byUid = new Map(file.summaries.map(summary => [summary.uid, summary]));
          for (const summary of summaries) byUid.set(summary.uid, summary);
          return { ...file, summaries: [...byUid.values()] };
        }),
      deleteSummaries: uids => {
        const gone = new Set(uids);
        return update(file => ({
          ...file,
          summaries: file.summaries.filter(({ uid }) => !gone.has(uid)),
        }));
      },
      updateSummaries: (uids, change) => {
        const changing = new Set(uids);
        return update(file => ({
          ...file,
          summaries: file.summaries.map(summary =>
            changing.has(summary.uid) ? change(summary) : summary,
          ),
        }));
      },
      getBody: uid =>
        run(
          Effect.gen(function* () {
            const { sync } = yield* current;
            if (sync === null) return null;
            const body = yield* read(bodyName(sync.uidValidity, uid), BodyJson);
            return Option.isSome(body) ? asFetchedBody(body.value) : null;
          }),
        ),
      listBodyUids: () =>
        run(Effect.map(current, ({ previews }) => new Set(previews.map(({ uid }) => uid)))),
      listPreviews: () => run(Effect.map(current, ({ previews }) => previews)),
      putBody: async (uid, body) => {
        const { sync } = await run(current);
        // A folder with no mark has nothing a uid could be read under.
        if (sync === null) return;
        await run(write(bodyName(sync.uidValidity, uid), BodyJson, body));
        await update(file => ({
          ...file,
          previews: [
            ...file.previews.filter(preview => preview.uid !== uid),
            { uid, paragraphs: body.paragraphs },
          ],
        }));
      },
    };
    // A sync holds on to this object across a clear, so the clear empties it rather than replacing it.
    const forget = () => {
      held = null;
    };
    return { cache, forget };
  };

  const folders = new Map<Folder, ReturnType<typeof folderCache>>();
  const mail: MailCache = {
    folder: folder => {
      const existing = folders.get(folder);
      if (existing !== undefined) return existing.cache;
      const created = folderCache(folder);
      folders.set(folder, created);
      return created.cache;
    },
    clear: async () => {
      await run(
        fs.remove(dir, { recursive: true, force: true }).pipe(Effect.mapError(unusable('written'))),
      );
      for (const { forget } of folders.values()) forget();
    },
  };

  return {
    mail,
    /**
     * When the account's last sync that landed started; none when a folder's file did not open,
     * which the next sync rebuilds. A body that does not open is only fetched again.
     */
    syncedAt: Effect.gen(function* () {
      const at = yield* read('account.bin', AccountJson);
      yield* Effect.forEach(FOLDERS, folder => usingCache(() => mail.folder(folder).getSync()), {
        discard: true,
      });
      return isDamaged ? Option.none<number>() : Option.map(at, ({ syncedAt }) => syncedAt);
    }).pipe(Effect.provideContext(context)),
    /** A sync landed: what the cache holds is what it read. */
    setSyncedAt: (syncedAt: number) =>
      write('account.bin', AccountJson, { syncedAt }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            isDamaged = false;
          }),
        ),
        Effect.provideContext(context),
      ),
    /** What the cache holds may not be where the mail is: the next read syncs first. */
    markStale: fs
      .remove(path.join(dir, 'account.bin'), { force: true })
      .pipe(Effect.mapError(unusable('written'))),
  };
});

export type AccountCache = Effect.Success<ReturnType<typeof accountCache>>;
