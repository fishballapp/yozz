import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import { listDrafts } from '@yozz.app/mail/compose/draft-vault';
import { listSentRecords } from '@yozz.app/mail/compose/sent-vault';
import type { MailConnectionFailure } from '@yozz.app/mail/connection';
import type { MailCache } from '@yozz.app/mail/threads/cache';
import { cachedPreviews, cachedSummaries, threadList } from '@yozz.app/mail/threads/hydrate';
import type { AccountSummaries, FolderSummaries } from '@yozz.app/mail/threads/summaries';
import { loadOlder, syncAccount } from '@yozz.app/mail/threads/sync';
import { staleAccounts } from '@yozz.app/mail/threads/sync-staleness';
import { FOLDERS, type Folder, type ThreadState } from '@yozz.app/mail/threads/thread';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type {
  ApiError,
  KeyRevoked,
  MailServerError,
  NetworkError,
  UsageError,
  VaultUnreadable,
} from '../errors.ts';
import { Mail, mailServerError } from '../mail/mail.ts';
import { Settings } from '../settings.ts';
import { Vault } from '../vault/vault.ts';
import { type AccountCache, accountCache, usingCache } from './disk.ts';

type VaultFailure = KeyRevoked | NetworkError | ApiError | UsageError | VaultUnreadable;

export class Cache extends Context.Service<
  Cache,
  {
    /** The account's `MailCache`, `@yozz.app/mail`'s port. */
    readonly of: (account: InboundAddress) => MailCache;
    /**
     * Syncs each account whose last sync started two minutes or more ago, the web app's own
     * threshold (`RETURN_SYNC_FRESH_MS`), or every one when `force`d. The rest answer from the cache,
     * and so does an account whose sync failed: it is answered among `failed`, and the others go on.
     */
    readonly sync: (
      accounts: readonly InboundAddress[],
      options: { readonly force: boolean },
    ) => Effect.Effect<{ readonly failed: readonly MailServerError[] }, UsageError>;
    /** `sync` for a read: fails only when every one of `accounts` failed, as nothing could answer. */
    readonly syncSome: (
      accounts: readonly InboundAddress[],
      options: { readonly force: boolean },
    ) => Effect.Effect<
      { readonly failed: readonly MailServerError[] },
      MailServerError | UsageError
    >;
    /** When each account's last sync started, as ISO; null for one never synced. */
    readonly syncedAt: (
      accounts: readonly InboundAddress[],
    ) => Effect.Effect<Readonly<Record<string, string | null>>, UsageError>;
    /**
     * Every conversation the cache and the vault hold, threaded across every account as the web app
     * does, so the ids are its own. `extra` (search hits) is threaded in without being stored.
     */
    readonly threads: (
      extra?: AccountSummaries,
    ) => Effect.Effect<readonly ThreadState[], VaultFailure>;
    /** The account's cache may not be where its mail is now: its next read syncs first. */
    readonly markStale: (account: InboundAddress) => Effect.Effect<void, UsageError>;
    /** Whether any account holds older mail in `folder` than its cache reaches. */
    readonly hasOlder: (
      accounts: readonly InboundAddress[],
      folder: Folder,
    ) => Effect.Effect<boolean, UsageError>;
    /** One window further back in `folder` on each account, as Older mail does. */
    readonly loadOlder: (
      accounts: readonly InboundAddress[],
      folder: Folder,
    ) => Effect.Effect<void, MailServerError | UsageError>;
  }
>()('@yozz.app/cli/Cache') {
  /** `$XDG_CACHE_HOME/yozz/<userId>/`, a directory per account, sealed under the vault's cache key. */
  static readonly layer = Layer.effect(
    Cache,
    Effect.gen(function* () {
      const mail = yield* Mail;
      const vault = yield* Vault;
      const settings = yield* Settings;
      const path = yield* Path.Path;
      const root = settings.cacheDir(vault.account.userId);
      const caches = new Map<string, AccountCache>(
        yield* Effect.forEach(
          mail.accounts,
          Effect.fnUntraced(function* (account) {
            // The address and the mailbox it reads: an address moved to another server or login
            // starts a new, empty cache, so no uid of the old one names the new one's mail.
            const { host, port, username } = account.imap;
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(JSON.stringify([account.address, host, port, username])),
              ),
            );
            // Hex, not the address: a case-insensitive file system would fold two addresses into one.
            // ponytail: an unkeyed digest, so someone who can already read this home directory can
            // guess which addresses have a cache here. The mail inside stays sealed. Un-park if the
            // directory names are ever held to the zero-knowledge claim.
            const name = new Uint8Array(digest).toHex().slice(0, 32);
            const cache = yield* accountCache({
              dir: path.join(root, name),
              key: vault.cacheKey,
              account: account.address,
            });
            return [account.address, cache] as const;
          }),
          { concurrency: 'unbounded' },
        ),
      );
      const cacheOf = (account: { readonly address: string }) => {
        const cache = caches.get(account.address);
        if (cache === undefined) throw new Error(`${account.address} has no cache`);
        return cache;
      };
      const failed = (account: InboundAddress, failure: MailConnectionFailure) =>
        mailServerError({ address: account.address, host: account.imap.host }, failure);

      /**
       * One pass over the account. A `UIDVALIDITY` change found partway clears the whole cache,
       * folders already written included, so that pass goes round once more before it counts.
       */
      const syncNow = Effect.fnUntraced(function* (account: InboundAddress) {
        const startedAt = yield* Clock.currentTimeMillis;
        const { state } = yield* usingCache(() =>
          syncAccount(mail.runOn(account), cacheOf(account).mail),
        );
        if (state.status === 'failed') return yield* failed(account, state.failure);
        yield* cacheOf(account).setSyncedAt(startedAt);
      });

      const sync = Effect.fn('Cache.sync')(function* (
        accounts: readonly InboundAddress[],
        { force }: { readonly force: boolean },
      ) {
        const now = yield* Clock.currentTimeMillis;
        const lastStartedAt = new Map(
          yield* Effect.forEach(
            accounts,
            account =>
              Effect.map(
                cacheOf(account).syncedAt,
                at => [account.address, Option.getOrUndefined(at)] as const,
              ),
            { concurrency: 'unbounded' },
          ),
        );
        const due = force
          ? accounts
          : staleAccounts(
              accounts,
              new Map(
                [...lastStartedAt].flatMap(([address, at]) =>
                  at === undefined ? [] : [[address, at]],
                ),
              ),
              now,
            );
        // A mail server's failure is that account's alone; a cache the disk refuses is everyone's.
        const results = yield* Effect.forEach(
          due,
          account =>
            syncNow(account).pipe(
              Effect.as(null),
              Effect.catchTag('MailServerError', error => Effect.succeed(error)),
            ),
          { concurrency: 'unbounded' },
        );
        return { failed: results.filter(error => error !== null) };
      });

      return Cache.of({
        of: account => cacheOf(account).mail,
        sync,
        markStale: account => cacheOf(account).markStale,
        syncSome: Effect.fn('Cache.syncSome')(function* (accounts, options) {
          const { failed } = yield* sync(accounts, options);
          const [first] = failed;
          if (first !== undefined && failed.length === accounts.length) return yield* first;
          return { failed };
        }),

        syncedAt: Effect.fn('Cache.syncedAt')(function* (accounts) {
          const entries = yield* Effect.forEach(
            accounts,
            account =>
              Effect.map(
                cacheOf(account).syncedAt,
                at =>
                  [
                    account.address,
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
            mail.accounts,
            account =>
              usingCache(async () => {
                const cache = cacheOf(account).mail;
                const [summaries, previews] = await Promise.all([
                  cachedSummaries(cache),
                  cachedPreviews(cache, account.address),
                ]);
                return { address: account.address, summaries, previews };
              }),
            { concurrency: 'unbounded' },
          );
          const [drafts, vaultSent] = yield* vault.use(store =>
            Promise.all([listDrafts(store), listSentRecords(store)]),
          );
          return threadList({
            byAccount: Object.fromEntries(
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
        hasOlder: Effect.fn('Cache.hasOlder')(function* (accounts, folder) {
          const marks = yield* Effect.forEach(
            accounts,
            account => usingCache(() => cacheOf(account).mail.folder(folder).getSync()),
            { concurrency: 'unbounded' },
          );
          return marks.some(mark => mark !== null && !mark.complete);
        }),
        loadOlder: Effect.fn('Cache.loadOlder')(function* (accounts, folder) {
          yield* Effect.forEach(
            accounts,
            Effect.fnUntraced(function* (account) {
              const res = yield* usingCache(() =>
                loadOlder(mail.runOn(account), cacheOf(account).mail.folder(folder)),
              );
              if (!res.ok) return yield* failed(account, res.error);
            }),
            { concurrency: 'unbounded', discard: true },
          );
        }),
      });
    }),
  );
}

/** The cached summaries with `extra`'s laid over them by uid, in folders read under the same UIDVALIDITY. */
const withExtra = (cached: FolderSummaries, extra: FolderSummaries): FolderSummaries =>
  Object.fromEntries(
    FOLDERS.flatMap(folder => {
      const read = cached[folder];
      if (read === undefined) return [];
      const added = extra[folder];
      if (added === undefined || added.uidValidity !== read.uidValidity) return [[folder, read]];
      const byUid = new Map(
        [...read.summaries, ...added.summaries].map(summary => [summary.uid, summary]),
      );
      return [[folder, { ...read, summaries: [...byUid.values()] }]];
    }),
  );

/** Every service the mail commands use, over the vault. */
export const MailboxLayer = Cache.layer.pipe(
  Layer.provideMerge(Mail.layer),
  Layer.provideMerge(Vault.layer),
);
