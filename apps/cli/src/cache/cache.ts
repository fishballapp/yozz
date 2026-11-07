import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import { listDrafts } from '@yozz.app/mail/compose/draft-vault';
import { listSentRecords } from '@yozz.app/mail/compose/sent-vault';
import type { MailConnectionFailure } from '@yozz.app/mail/connection';
import type { MailCache } from '@yozz.app/mail/threads/cache';
import { createSnapshotWriter, restoreSnapshot } from '@yozz.app/mail/threads/cache-snapshot';
import {
  cachedPreviews,
  cachedSummaries,
  threadList,
  withExtra,
} from '@yozz.app/mail/threads/hydrate';
import { olderFrontier } from '@yozz.app/mail/threads/paging';
import type { MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import { loadOlder, syncMailbox } from '@yozz.app/mail/threads/sync';
import { staleMailboxes } from '@yozz.app/mail/threads/sync-staleness';
import type { Folder, ThreadState } from '@yozz.app/mail/threads/thread';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FiberSet from 'effect/FiberSet';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type {
  ApiError,
  KeyRevoked,
  MailServerError,
  NetworkError,
  StorageFull,
  UsageError,
  VaultUnreadable,
} from '../errors.ts';
import { Mail, mailServerError } from '../mail/mail.ts';
import { Settings } from '../settings.ts';
import { Vault } from '../vault/vault.ts';
import { type MailboxCache, mailboxCache, usingCache } from './disk.ts';

/** How long a command waits at exit for its snapshot write, which is best effort. */
const SNAPSHOT_EXIT_WAIT = '10 seconds';

type VaultFailure =
  | KeyRevoked
  | NetworkError
  | ApiError
  | StorageFull
  | UsageError
  | VaultUnreadable;

export class Cache extends Context.Service<
  Cache,
  {
    /** The mailbox's `MailCache`, `@yozz.app/mail`'s port. */
    readonly of: (mailbox: InboundAddress) => MailCache;
    /**
     * Syncs each mailbox whose last sync started two minutes or more ago, the web app's own
     * threshold (`RETURN_SYNC_FRESH_MS`), or every one when `force`d. The rest answer from the cache,
     * and so does a mailbox whose sync failed: it is answered among `failed`, and the others go on.
     */
    readonly sync: (
      mailboxes: readonly InboundAddress[],
      options: { readonly force: boolean },
    ) => Effect.Effect<{ readonly failed: readonly MailServerError[] }, UsageError>;
    /** `sync` for a read: fails only when every one of `mailboxes` failed, as nothing could answer. */
    readonly syncSome: (
      mailboxes: readonly InboundAddress[],
      options: { readonly force: boolean },
    ) => Effect.Effect<
      { readonly failed: readonly MailServerError[] },
      MailServerError | UsageError
    >;
    /** When each mailbox's last sync started, as ISO; null for one never synced. */
    readonly syncedAt: (
      mailboxes: readonly InboundAddress[],
    ) => Effect.Effect<Readonly<Record<string, string | null>>, UsageError>;
    /**
     * Every conversation the cache and the vault hold, threaded across every mailbox as the web app
     * does, so the ids are its own. `extra` (search hits) is threaded in without being stored.
     */
    readonly threads: (
      extra?: MailboxSummaries,
    ) => Effect.Effect<readonly ThreadState[], VaultFailure>;
    /** The mailbox's cache may not be where its mail is now: its next read syncs first. */
    readonly markStale: (mailbox: InboundAddress) => Effect.Effect<void, UsageError>;
    /** Where searches found the mailbox's mail outside the cached window. */
    readonly found: (mailbox: InboundAddress) => MailboxCache['found'];
    /**
     * The folder that stops short soonest of those holding older mail than the cache reaches, or
     * null when none does. Older than `reachedAt`, a list across them may be missing mail.
     */
    readonly olderFrontier: (
      mailboxes: readonly InboundAddress[],
      folders: readonly Folder[],
    ) => Effect.Effect<
      {
        readonly mailbox: InboundAddress;
        readonly folder: Folder;
        readonly reachedAt: number;
      } | null,
      UsageError
    >;
    /** One window further back in that folder, as Older mail does. */
    readonly loadOlder: (
      mailbox: InboundAddress,
      folder: Folder,
    ) => Effect.Effect<void, MailServerError | UsageError>;
  }
>()('@yozz.app/cli/Cache') {
  /**
   * `$XDG_CACHE_HOME/yozz/<userId>/`, a directory per mailbox, sealed under the vault's cache key. A
   * mailbox with no cache here starts from the vault's snapshot of its list, and each sync that lands
   * may write a new one, which the command waits for only once its own answer is out.
   */
  static readonly layer = Layer.effect(
    Cache,
    Effect.gen(function* () {
      const mail = yield* Mail;
      const vault = yield* Vault;
      const settings = yield* Settings;
      const path = yield* Path.Path;
      const root = settings.cacheDir(vault.account.userId);
      // Neither snapshot call rejects, so the stores are taken out of `use` once.
      const [store, files] = yield* vault
        .use(async (records, files) => [records, files] as const)
        .pipe(Effect.orDie);
      const snapshots = createSnapshotWriter({ store, files });
      const saving = yield* FiberSet.make();
      // Best effort, so a vault that stops answering costs the snapshot, not the command's exit.
      yield* Effect.addFinalizer(() =>
        FiberSet.awaitEmpty(saving).pipe(Effect.timeoutOption(SNAPSHOT_EXIT_WAIT)),
      );
      const caches = new Map<string, MailboxCache>(
        yield* Effect.forEach(
          mail.mailboxes,
          Effect.fnUntraced(function* (mailbox) {
            // The address and the mailbox it reads: an address moved to another server or login
            // starts a new, empty cache, so no uid of the old one names the new one's mail.
            const { host, port, username } = mailbox.imap;
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(JSON.stringify([mailbox.address, host, port, username])),
              ),
            );
            // Hex, not the address: a case-insensitive file system would fold two addresses into one.
            // ponytail: an unkeyed digest, so someone who can already read this home directory can
            // guess which addresses have a cache here. The mail inside stays sealed. Un-park if the
            // directory names are ever held to the zero-knowledge claim.
            const name = new Uint8Array(digest).toHex().slice(0, 32);
            const cache = yield* mailboxCache({
              dir: path.join(root, name),
              key: vault.cacheKey,
              mailbox: mailbox.address,
            });
            return [mailbox.address, cache] as const;
          }),
          { concurrency: 'unbounded' },
        ),
      );
      const cacheOf = (mailbox: { readonly address: string }) => {
        const cache = caches.get(mailbox.address);
        if (cache === undefined) throw new Error(`${mailbox.address} has no cache`);
        return cache;
      };
      const failed = (mailbox: InboundAddress, failure: MailConnectionFailure) =>
        mailServerError({ address: mailbox.address, host: mailbox.imap.host }, failure);

      /**
       * One pass over the mailbox. A `UIDVALIDITY` change found partway clears the whole cache,
       * folders already written included, so that pass goes round once more before it counts.
       */
      const syncNow = Effect.fnUntraced(function* (mailbox: InboundAddress) {
        const startedAt = yield* Clock.currentTimeMillis;
        const cache = cacheOf(mailbox).mail;
        yield* Effect.promise(() => restoreSnapshot({ store, files, cache, mailbox }));
        const { state } = yield* usingCache(() => syncMailbox(mail.runOn(mailbox), cache));
        if (state.status === 'failed') return yield* failed(mailbox, state.failure);
        yield* cacheOf(mailbox).setSyncedAt(startedAt);
        yield* FiberSet.run(
          saving,
          Effect.promise(() => snapshots.save(mailbox, cache)),
        );
      });

      const sync = Effect.fn('Cache.sync')(function* (
        mailboxes: readonly InboundAddress[],
        { force }: { readonly force: boolean },
      ) {
        const now = yield* Clock.currentTimeMillis;
        const lastStartedAt = new Map(
          yield* Effect.forEach(
            mailboxes,
            mailbox =>
              Effect.map(
                cacheOf(mailbox).syncedAt,
                at => [mailbox.address, Option.getOrUndefined(at)] as const,
              ),
            { concurrency: 'unbounded' },
          ),
        );
        const due = force
          ? mailboxes
          : staleMailboxes(
              mailboxes,
              new Map(
                [...lastStartedAt].flatMap(([address, at]) =>
                  at === undefined ? [] : [[address, at]],
                ),
              ),
              now,
            );
        // A mail server's failure is that mailbox's alone; a cache the disk refuses is everyone's.
        const results = yield* Effect.forEach(
          due,
          mailbox =>
            syncNow(mailbox).pipe(
              Effect.as(null),
              Effect.catchTag('MailServerError', error => Effect.succeed(error)),
            ),
          { concurrency: 'unbounded' },
        );
        return { failed: results.filter(error => error !== null) };
      });

      return Cache.of({
        of: mailbox => cacheOf(mailbox).mail,
        sync,
        markStale: mailbox => cacheOf(mailbox).markStale,
        found: mailbox => cacheOf(mailbox).found,
        syncSome: Effect.fn('Cache.syncSome')(function* (mailboxes, options) {
          const { failed } = yield* sync(mailboxes, options);
          const [first] = failed;
          if (first !== undefined && failed.length === mailboxes.length) return yield* first;
          return { failed };
        }),

        syncedAt: Effect.fn('Cache.syncedAt')(function* (mailboxes) {
          const entries = yield* Effect.forEach(
            mailboxes,
            mailbox =>
              Effect.map(
                cacheOf(mailbox).syncedAt,
                at =>
                  [
                    mailbox.address,
                    Option.match(at, {
                      onNone: () => null,
                      onSome: ms => new Date(ms).toISOString(),
                    }),
                  ] as const,
              ),
            { concurrency: 'unbounded' },
          );
          return Object.fromEntries(entries);
        }),
        threads: Effect.fn('Cache.threads')(function* (extra = {}) {
          const read = yield* Effect.forEach(
            mail.mailboxes,
            mailbox =>
              usingCache(async () => {
                const cache = cacheOf(mailbox).mail;
                const [summaries, previews] = await Promise.all([
                  cachedSummaries(cache),
                  cachedPreviews(cache, mailbox.address),
                ]);
                return { address: mailbox.address, summaries, previews };
              }),
            { concurrency: 'unbounded' },
          );
          const [drafts, vaultSent] = yield* vault.use(store =>
            Promise.all([listDrafts(store), listSentRecords(store)]),
          );
          return threadList({
            byMailbox: Object.fromEntries(
              read.map(({ address, summaries }) => [
                address,
                withExtra(summaries, extra[address] ?? {}),
              ]),
            ),
            vaultSent,
            previews: Object.assign({}, ...read.map(({ previews }) => previews)),
            drafts,
          });
        }),
        olderFrontier: Effect.fn('Cache.olderFrontier')(function* (mailboxes, folders) {
          const windows = yield* Effect.forEach(
            mailboxes.flatMap(mailbox => folders.map(folder => ({ mailbox, folder }))),
            ({ mailbox, folder }) =>
              usingCache(async () => {
                const folderCache = cacheOf(mailbox).mail.folder(folder);
                const [mark, summaries] = await Promise.all([
                  folderCache.getSync(),
                  folderCache.listSummaries(),
                ]);
                return mark === null
                  ? []
                  : [{ mailbox: mailbox.address, folder, summaries, isComplete: mark.complete }];
              }),
            { concurrency: 'unbounded' },
          );
          const frontier = olderFrontier(windows.flat());
          const mailbox = mailboxes.find(({ address }) => address === frontier?.mailbox);
          return frontier === null || mailbox === undefined ? null : { ...frontier, mailbox };
        }),
        loadOlder: Effect.fn('Cache.loadOlder')(function* (mailbox, folder) {
          const res = yield* usingCache(() =>
            loadOlder(mail.runOn(mailbox), cacheOf(mailbox).mail.folder(folder)),
          );
          if (!res.ok) return yield* failed(mailbox, res.error);
        }),
      });
    }),
  );
}

/** Every service the mail commands use, over the vault. */
export const MailboxLayer = Cache.layer.pipe(
  Layer.provideMerge(Mail.layer),
  Layer.provideMerge(Vault.layer),
);
