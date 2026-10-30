import { type ImapMessageSummary, uidSets } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailTask } from '@yozz.app/mail/connection';
import type { AccountSummaries, FolderSummaries } from '@yozz.app/mail/threads/summaries';
import {
  FOLDERS,
  type Folder,
  type Location,
  type ThreadState,
} from '@yozz.app/mail/threads/thread';
import * as Effect from 'effect/Effect';
import { Cache } from '../cache/cache.ts';
import { usingCache } from '../cache/disk.ts';
import type { MailServerError, UsageError } from '../errors.ts';
import { Mail } from './mail.ts';

/** How many matches a query reads in each folder, newest first: one sync window's worth. */
export const SEARCH_HITS = 200;

const hitKey = ({ account, folder, uid }: Omit<Location, 'uidValidity'>) =>
  `${account}/${folder}/${uid}`;

/**
 * `UID SEARCH TEXT` in one mailbox: the newest matches, and the summaries of those the cache does
 * not hold, which are read here and never written to it: the cache stays one contiguous window,
 * which the incremental sync and the older-mail paging rely on.
 */
const searchTask = ({
  mailbox,
  uidValidity,
  cached,
  text,
}: {
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly cached: ReadonlySet<number>;
  readonly text: string;
}): MailTask<{
  readonly hits: readonly number[];
  readonly summaries: readonly ImapMessageSummary[];
  /** The folder matched more than `SEARCH_HITS`, so the oldest were not read. */
  readonly hasMore: boolean;
}> => ({
  priority: 'user',
  effect: 'read',
  retry: true,
  run: async client => {
    const selected = await client.ensureSelected(mailbox);
    if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
    if (selected.value.uidValidity !== null && selected.value.uidValidity !== uidValidity) {
      return {
        ok: false,
        error: { kind: 'error', detail: 'a folder was renumbered; sync and search again' },
      };
    }
    const found = await client.uidSearchText(text);
    if (!found.ok) return { ok: false, error: { kind: 'imap', reason: found.reason } };
    const hits = found.value.toSorted((a, b) => b - a).slice(0, SEARCH_HITS);
    const summaries: ImapMessageSummary[] = [];
    for (const set of uidSets(hits.filter(uid => !cached.has(uid)))) {
      const fetched = await client.fetchSummaries(set);
      if (!fetched.ok) return { ok: false, error: { kind: 'imap', reason: fetched.reason } };
      summaries.push(...fetched.value);
    }
    return { ok: true, value: { hits, summaries, hasMore: found.value.length > hits.length } };
  },
});

/**
 * What `asking` made of each account's server: the folders it answered, or the failure that ended
 * its turn. One account's server failing leaves the others answering; only when every one fails is
 * that failure the command's own, as `Cache.syncSome` does for a sync.
 */
const perAccount = Effect.fnUntraced(function* <A>(
  accounts: readonly InboundAddress[],
  asking: (account: InboundAddress) => Effect.Effect<A, MailServerError | UsageError, Cache | Mail>,
) {
  const answers = yield* Effect.forEach(
    accounts,
    account =>
      asking(account).pipe(
        Effect.map(answer => ({ account, answer, failure: null })),
        Effect.catchTag('MailServerError', failure =>
          Effect.succeed({ account, answer: null, failure }),
        ),
      ),
    { concurrency: 'unbounded' },
  );
  const failed = answers.flatMap(({ failure }) => (failure === null ? [] : [failure]));
  const [first] = failed;
  if (first !== undefined && failed.length === accounts.length) return yield* first;
  return { answers, failed };
});

/**
 * Searches `folders` on every account on its server. Answers the summaries to thread in beside the
 * cache, whether a conversation holds a match, and the accounts whose server failed.
 */
export const searchMail = Effect.fn('mail.searchMail')(function* ({
  accounts,
  folders,
  text,
}: {
  readonly accounts: readonly InboundAddress[];
  readonly folders: readonly Folder[];
  readonly text: string;
}) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  const { answers, failed } = yield* perAccount(accounts, account =>
    Effect.forEach(
      folders,
      Effect.fnUntraced(function* (folder) {
        const folderCache = cache.of(account).folder(folder);
        const [mark, summaries] = yield* usingCache(() =>
          Promise.all([folderCache.getSync(), folderCache.listSummaries()]),
        );
        // A folder the server does not have holds nothing to find.
        if (mark === null) {
          return { account, folder, uidValidity: 0, hits: [], summaries: [], hasMore: false };
        }
        const result = yield* mail.use(account, run =>
          run(
            searchTask({
              mailbox: mark.name,
              uidValidity: mark.uidValidity,
              cached: new Set(summaries.map(({ uid }) => uid)),
              text,
            }),
          ),
        );
        return { account, folder, uidValidity: mark.uidValidity, ...result };
      }),
      // One connection per account answers its folders in turn.
      { concurrency: 1 },
    ),
  );
  const results = answers.flatMap(({ answer }) => answer ?? []);
  const extra: AccountSummaries = Object.fromEntries(
    accounts.map(({ address }) => [
      address,
      Object.fromEntries(
        results
          .filter(({ account }) => account.address === address)
          .map(({ folder, uidValidity, summaries }) => [folder, { uidValidity, summaries }]),
      ) satisfies FolderSummaries,
    ]),
  );
  const hits = new Set(
    results.flatMap(({ account, folder, hits }) =>
      hits.map(uid => hitKey({ account: account.address, folder, uid })),
    ),
  );
  return {
    extra,
    failed,
    hasMoreMatches: results.some(({ hasMore }) => hasMore),
    isHit: (thread: ThreadState) =>
      thread.messages.some(message =>
        (message.locations ?? []).some(location => hits.has(hitKey(location))),
      ),
  };
});

/** What a handle names on the server: a Message-ID, or one uid in one folder. */
type Wanted =
  | { readonly kind: 'messageId'; readonly messageId: string }
  | { readonly kind: 'uid'; readonly uid: number };

/** What `id` asks of `folder` in `account`, whose mark is `uidValidity`; null when nothing. */
const wantedIn = (
  id: string,
  { account, folder, uidValidity }: { account: string; folder: Folder; uidValidity: number },
): Wanted | null => {
  if (id.startsWith('mid/')) return { kind: 'messageId', messageId: id.slice('mid/'.length) };
  const [holder, inFolder, validity, uid] = id.split('/');
  const isHere = holder === account && inFolder === folder && Number(validity) === uidValidity;
  return isHere && Number.isSafeInteger(Number(uid)) ? { kind: 'uid', uid: Number(uid) } : null;
};

/** The messages `wanted` names in one mailbox, read for this answer and never stored. */
const lookUpTask = ({
  mailbox,
  uidValidity,
  wanted,
}: {
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly wanted: readonly Wanted[];
}): MailTask<readonly ImapMessageSummary[]> => ({
  priority: 'user',
  effect: 'read',
  retry: true,
  run: async client => {
    const selected = await client.ensureSelected(mailbox);
    if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
    if (selected.value.uidValidity !== null && selected.value.uidValidity !== uidValidity) {
      return { ok: true, value: [] };
    }
    const uids = new Set<number>();
    const messageIds = new Set<string>();
    for (const want of wanted) {
      if (want.kind === 'uid') {
        uids.add(want.uid);
        continue;
      }
      messageIds.add(want.messageId);
      const found = await client.uidSearchHeader('Message-ID', want.messageId);
      if (!found.ok) return { ok: false, error: { kind: 'imap', reason: found.reason } };
      for (const uid of found.value) uids.add(uid);
    }
    const summaries: ImapMessageSummary[] = [];
    for (const set of uidSets([...uids])) {
      const fetched = await client.fetchSummaries(set);
      if (!fetched.ok) return { ok: false, error: { kind: 'imap', reason: fetched.reason } };
      summaries.push(...fetched.value);
    }
    // A header search may match by substring; a uid asked for is kept as it is.
    return {
      ok: true,
      value: summaries.filter(
        ({ uid, envelope }) =>
          wanted.some(want => want.kind === 'uid' && want.uid === uid) ||
          messageIds.has(envelope?.messageId ?? ''),
      ),
    };
  },
});

/**
 * Ids the cache does not hold, found on the servers of `accounts`: a `mid/` id by its Message-ID in
 * every folder, a location id at its uid. Answered as summaries to thread in beside the cache, which
 * stays the window the syncs keep, and the accounts whose server failed.
 */
export const lookUp = Effect.fn('mail.lookUp')(function* ({
  accounts,
  ids,
}: {
  readonly accounts: readonly InboundAddress[];
  readonly ids: readonly string[];
}) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  if (ids.length === 0) return { extra: {} satisfies AccountSummaries, failed: [] };
  const { answers, failed } = yield* perAccount(accounts, account =>
    Effect.forEach(
      FOLDERS.filter(folder => folder !== 'drafts'),
      Effect.fnUntraced(function* (folder) {
        const mark = yield* usingCache(() => cache.of(account).folder(folder).getSync());
        const wanted =
          mark === null
            ? []
            : ids.flatMap(
                id =>
                  wantedIn(id, {
                    account: account.address,
                    folder,
                    uidValidity: mark.uidValidity,
                  }) ?? [],
              );
        if (mark === null || wanted.length === 0) return null;
        const summaries = yield* mail.use(account, run =>
          run(lookUpTask({ mailbox: mark.name, uidValidity: mark.uidValidity, wanted })),
        );
        return [folder, { uidValidity: mark.uidValidity, summaries }] as const;
      }),
      { concurrency: 1 },
    ),
  );
  // An account that failed answers nothing; the others still do.
  const found = answers.flatMap(({ account, answer }) =>
    answer === null
      ? []
      : [
          [
            account.address,
            Object.fromEntries(answer.filter(entry => entry !== null)) satisfies FolderSummaries,
          ] as const,
        ],
  );
  return { extra: Object.fromEntries(found) satisfies AccountSummaries, failed };
});
