import { type ImapMessageSummary, uidSets } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailTask } from '@yozz.app/mail/connection';
import { assembleMatches } from '@yozz.app/mail/threads/found';
import { withExtra } from '@yozz.app/mail/threads/hydrate';
import type { SearchQuery } from '@yozz.app/mail/threads/query';
import { searchMailbox } from '@yozz.app/mail/threads/search';
import type { FolderSummaries, MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import {
  FOLDERS,
  type Folder,
  isServerCopy,
  resolveHandles,
  type ThreadState,
} from '@yozz.app/mail/threads/thread';
import * as Effect from 'effect/Effect';
import { Cache } from '../cache/cache.ts';
import { type FoundCopy, usingCache } from '../cache/disk.ts';
import type { MailServerError, UsageError } from '../errors.ts';
import { Mail } from './mail.ts';

/**
 * What `asking` made of each mailbox's server: the folders it answered, or the failure that ended
 * its turn. One mailbox's server failing leaves the others answering; only when every one fails is
 * that failure the command's own, as `Cache.syncSome` does for a sync.
 */
const perMailbox = Effect.fnUntraced(function* <A>(
  mailboxes: readonly InboundAddress[],
  asking: (mailbox: InboundAddress) => Effect.Effect<A, MailServerError | UsageError, Cache | Mail>,
) {
  const answers = yield* Effect.forEach(
    mailboxes,
    mailbox =>
      asking(mailbox).pipe(
        Effect.map(answer => ({ mailbox, answer, failure: null })),
        Effect.catchTag('MailServerError', failure =>
          Effect.succeed({ mailbox, answer: null, failure }),
        ),
      ),
    { concurrency: 'unbounded' },
  );
  const failed = answers.flatMap(({ failure }) => (failure === null ? [] : [failure]));
  const [first] = failed;
  if (first !== undefined && failed.length === mailboxes.length) return yield* first;
  return { answers, failed };
});

/** Every copy in `extra` with a Message-ID, remembered by its mailbox as found where it is. */
export const rememberFound = Effect.fnUntraced(function* (extra: MailboxSummaries) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  const copiesIn = (folders: FolderSummaries) =>
    FOLDERS.flatMap(folder => {
      const read = folders[folder];
      if (read === undefined) return [];
      return read.summaries.flatMap(({ uid, envelope }): FoundCopy[] =>
        envelope?.messageId
          ? [{ messageId: envelope.messageId, folder, uidValidity: read.uidValidity, uid }]
          : [],
      );
    });
  yield* Effect.forEach(
    mail.mailboxes,
    mailbox => cache.found(mailbox).remember(copiesIn(extra[mailbox.address] ?? {})),
    { concurrency: 'unbounded', discard: true },
  );
});

/**
 * Searches `folders` on every mailbox on its server. Answers the summaries to thread in beside the
 * cache, whether a conversation holds a match, and the mailboxes whose server failed. What the
 * cache lacks is remembered where it was found, so following a hit up searches for nothing.
 */
export const searchMail = Effect.fn('mail.searchMail')(function* ({
  mailboxes,
  folders,
  query,
}: {
  readonly mailboxes: readonly InboundAddress[];
  readonly folders: readonly Folder[];
  readonly query: SearchQuery;
}) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  const { answers, failed } = yield* perMailbox(mailboxes, mailbox =>
    mail.use(mailbox, run => searchMailbox({ run, cache: cache.of(mailbox), folders, query })),
  );
  const matches = assembleMatches(
    answers.flatMap(({ mailbox, answer }) =>
      answer === null ? [] : [{ address: mailbox.address, matches: answer }],
    ),
  );
  yield* rememberFound(matches.extra);
  return { ...matches, failed };
});

/**
 * What a handle names in one folder: a Message-ID to search for, or a uid to fetch, which with a
 * `messageId` (a copy a search found before) counts only while it is still that message.
 */
type Wanted =
  | { readonly kind: 'messageId'; readonly messageId: string }
  | { readonly kind: 'uid'; readonly uid: number; readonly messageId?: string };

const messageIdOf = (id: string) => (id.startsWith('mid/') ? id.slice('mid/'.length) : null);

/** The mailbox, folder, UIDVALIDITY and uid a location id names; null for any other id. */
const locationOf = (id: string) => {
  const [mailbox, folder, uidValidity, uid] = id.split('/');
  const isLocation =
    mailbox !== undefined &&
    FOLDERS.some(known => known === folder) &&
    Number.isSafeInteger(Number(uidValidity)) &&
    Number.isSafeInteger(Number(uid));
  return isLocation
    ? { mailbox, folder, uidValidity: Number(uidValidity), uid: Number(uid) }
    : null;
};

/** The messages `wanted` names in one folder, read for this answer and never stored. */
const lookUpTask = ({
  folderName,
  uidValidity,
  wanted,
}: {
  readonly folderName: string;
  readonly uidValidity: number;
  readonly wanted: readonly Wanted[];
}): MailTask<readonly ImapMessageSummary[]> => ({
  priority: 'user',
  effect: 'read',
  retry: true,
  run: async client => {
    const selected = await client.ensureSelected(folderName);
    if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
    if (selected.value.uidValidity !== null && selected.value.uidValidity !== uidValidity) {
      return { ok: true, value: [] };
    }
    const uids = new Set<number>();
    const searchedFor = new Set<string>();
    for (const want of wanted) {
      if (want.kind === 'uid') {
        uids.add(want.uid);
        continue;
      }
      searchedFor.add(want.messageId);
      const found = await client.uidSearch({
        key: 'HEADER',
        header: 'Message-ID',
        value: want.messageId,
      });
      if (!found.ok) return { ok: false, error: { kind: 'imap', reason: found.reason } };
      for (const uid of found.value) uids.add(uid);
    }
    const summaries: ImapMessageSummary[] = [];
    for (const set of uidSets([...uids])) {
      const fetched = await client.fetchSummaries(set);
      if (!fetched.ok) return { ok: false, error: { kind: 'imap', reason: fetched.reason } };
      summaries.push(...fetched.value);
    }
    // A header search may match by substring, and a uid found before may hold other mail now.
    const isWanted = ({ uid, envelope }: ImapMessageSummary) => {
      const messageId = envelope?.messageId ?? '';
      return (
        searchedFor.has(messageId) ||
        wanted.some(
          want =>
            want.kind === 'uid' &&
            want.uid === uid &&
            (want.messageId === undefined || want.messageId === messageId),
        )
      );
    };
    return { ok: true, value: summaries.filter(isWanted) };
  },
});

/**
 * What `wantedOf` names in each folder of each mailbox, one task a folder, read for this answer
 * and never stored. Answered as summaries to thread in beside the cache, and the mailboxes whose
 * server failed.
 */
const readWanted = Effect.fnUntraced(function* (
  mailboxes: readonly InboundAddress[],
  wantedOf: (
    mailbox: InboundAddress,
  ) => Effect.Effect<(folder: Folder, uidValidity: number) => readonly Wanted[], UsageError, Cache>,
) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  const { answers, failed } = yield* perMailbox(
    mailboxes,
    Effect.fnUntraced(function* (mailbox) {
      const wantedIn = yield* wantedOf(mailbox);
      const read = yield* Effect.forEach(
        FOLDERS.filter(folder => folder !== 'drafts'),
        Effect.fnUntraced(function* (folder) {
          const mark = yield* usingCache(() => cache.of(mailbox).folder(folder).getSync());
          const wanted = mark === null ? [] : wantedIn(folder, mark.uidValidity);
          if (mark === null || wanted.length === 0) return [];
          const summaries = yield* mail.use(mailbox, run =>
            run(lookUpTask({ folderName: mark.name, uidValidity: mark.uidValidity, wanted })),
          );
          return [[folder, { uidValidity: mark.uidValidity, summaries }] as const];
        }),
        { concurrency: 1 },
      );
      return Object.fromEntries(read.flat()) satisfies FolderSummaries;
    }),
  );
  // A mailbox that failed answers nothing; the others still do.
  const found = answers.flatMap(({ mailbox, answer }) =>
    answer === null ? [] : [[mailbox.address, answer] as const],
  );
  return { extra: Object.fromEntries(found) satisfies MailboxSummaries, failed };
});

/** Ids the cache lacks that name a uid: a location id, or a Message-ID a search found before. */
const fetchKnown = Effect.fnUntraced(function* (
  mailboxes: readonly InboundAddress[],
  ids: readonly string[],
) {
  const cache = yield* Cache;
  const messageIds = new Set(ids.flatMap(id => messageIdOf(id) ?? []));
  const locations = ids.flatMap(id => locationOf(id) ?? []);
  return yield* readWanted(mailboxes, mailbox =>
    Effect.map(
      cache.found(mailbox).of(messageIds),
      found =>
        (folder, uidValidity): readonly Wanted[] => [
          ...locations
            .filter(
              copy =>
                copy.mailbox === mailbox.address &&
                copy.folder === folder &&
                copy.uidValidity === uidValidity,
            )
            .map(({ uid }) => ({ kind: 'uid', uid }) as const),
          ...found
            .filter(copy => copy.folder === folder && copy.uidValidity === uidValidity)
            .map(({ uid, messageId }) => ({ kind: 'uid', uid, messageId }) as const),
        ],
    ),
  );
});

/** Message-IDs in every folder of every mailbox, one search each, remembered where they are found. */
const searchMessageIds = Effect.fnUntraced(function* (
  mailboxes: readonly InboundAddress[],
  ids: readonly string[],
) {
  const wanted = ids.flatMap(id => {
    const messageId = messageIdOf(id);
    return messageId === null ? [] : [{ kind: 'messageId', messageId } as const];
  });
  if (wanted.length === 0) return { extra: {} satisfies MailboxSummaries, failed: [] };
  const read = yield* readWanted(mailboxes, () => Effect.succeed(() => wanted));
  yield* rememberFound(read.extra);
  return read;
});

/** Both answers' summaries, folder by folder. */
const mergeExtra = (a: MailboxSummaries, b: MailboxSummaries): MailboxSummaries =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map(address => [
      address,
      withExtra(a[address] ?? {}, b[address] ?? {}),
    ]),
  );

/** The mailboxes holding a copy of a conversation. */
const holdersOf = (thread: ThreadState) =>
  thread.messages.flatMap(({ locations }) =>
    (locations ?? []).filter(isServerCopy).map(({ mailbox }) => mailbox),
  );

/**
 * The conversations `ids` name, for `read`, `update` and `draft`. Named against the cache first;
 * then only the mailboxes holding a copy of them sync (`force`: however fresh), so a reply that
 * landed in a mailbox holding none shows once that one syncs. An id the cache lacks is fetched by
 * its uid where a search found it, or where a location id says, and its mailbox syncs as any other
 * holder does; only one nothing knows syncs every other mailbox, then is searched for by its
 * Message-ID.
 */
export const locate = Effect.fn('mail.locate')(function* ({
  ids,
  force,
}: {
  readonly ids: readonly string[];
  readonly force: boolean;
}) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  const resolved = Effect.fnUntraced(function* (extra: MailboxSummaries) {
    const threads = yield* cache.threads(extra);
    const entries = resolveHandles(threads, ids);
    const missing = entries.flatMap(({ id, thread }) => (thread === null ? [id] : []));
    return { threads, entries, missing, extra };
  });

  const asked = new Set<string>();
  const unsynced: MailServerError[] = [];
  const unanswered: MailServerError[] = [];
  const failed = () => [...unsynced, ...unanswered];
  const syncing = Effect.fnUntraced(function* (mailboxes: readonly InboundAddress[]) {
    for (const { address } of mailboxes) asked.add(address);
    unsynced.push(...(yield* cache.sync(mailboxes, { force })).failed);
  });
  const live = () =>
    mail.mailboxes.filter(({ address }) => !failed().some(error => error.address === address));
  type Located = Effect.Success<ReturnType<typeof resolved>>;
  /**
   * Syncs every mailbox holding a copy of what `located` found that has not synced yet, wherever
   * it was found (the cache, `found.bin`), then names the ids again: a sync can join another
   * mailbox's copy to the conversation, so this goes round until none is left.
   */
  const withHoldersSynced = (
    located: Located,
  ): Effect.Effect<Located, Effect.Error<ReturnType<typeof resolved>> | UsageError> =>
    Effect.gen(function* () {
      const holding = new Set(
        located.entries.flatMap(({ thread }) => (thread === null ? [] : holdersOf(thread))),
      );
      // A mailbox whose server already failed is not asked again: it answers from its cache.
      const due = live().filter(({ address }) => holding.has(address) && !asked.has(address));
      if (due.length === 0) return located;
      yield* syncing(due);
      return yield* withHoldersSynced(yield* resolved(located.extra));
    });
  const answer = (located: Located) => {
    const [first = null] = failed();
    const isEveryFailed =
      new Set(failed().map(({ address }) => address)).size === mail.mailboxes.length;
    return {
      ...located,
      /** The mailboxes that could not sync, which answer from their cache. */
      unsynced: [...unsynced],
      /** Every mailbox whose server failed, to sync or to look an id up. */
      failed: failed(),
      /** A failure when every mailbox's server failed, so an id found nowhere may still be on one. */
      everyFailed: isEveryFailed ? first : null,
    };
  };

  const cached = yield* withHoldersSynced(yield* resolved({}));
  if (cached.missing.length === 0) return answer(cached);
  const known = yield* fetchKnown(live(), cached.missing);
  unanswered.push(...known.failed);
  const withKnown = yield* withHoldersSynced(yield* resolved(known.extra));
  if (withKnown.missing.length === 0) return answer(withKnown);

  // A miss: the conversation may sit in a mailbox not synced yet, or outside every window.
  yield* syncing(live().filter(({ address }) => !asked.has(address)));
  const everywhere = yield* resolved(known.extra);
  if (everywhere.missing.length === 0) return answer(everywhere);
  const searched = yield* searchMessageIds(live(), everywhere.missing);
  unanswered.push(...searched.failed);
  return answer(yield* resolved(mergeExtra(known.extra, searched.extra)));
});
