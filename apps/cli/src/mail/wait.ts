import type { ImapFailure, ImapMessageSummary } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, MailTask, Result } from '@yozz.app/mail/connection';
import { messageMatches } from '@yozz.app/mail/threads/match';
import { parseQuery, type SearchQuery } from '@yozz.app/mail/threads/query';
import type { MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import type { Location, Message, ThreadState } from '@yozz.app/mail/threads/thread';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { Cache } from '../cache/cache.ts';
import { type MailServerError, type UsageError, WaitTimedOut } from '../errors.ts';
import { Mail } from './mail.ts';
import { rememberFound } from './search.ts';

/** The shortest round of waiting, so a server that keeps saying "changed" is not asked in a loop. */
const MIN_ROUND_MS = 1_000;

/** Where an inbox stands: its UIDVALIDITY, and the last uid it has given out. */
type InboxMark = { readonly uidValidity: number; readonly lastUid: number };

const READ = { priority: 'user', effect: 'read', retry: true } as const;

const imapFailure = (reason: ImapFailure): Result<never, MailConnectionFailure> => ({
  ok: false,
  error: { kind: 'imap', reason },
});

/** INBOX selected afresh, so the mark is the server's now and not a cache's. */
const lookTask: MailTask<InboxMark> = {
  ...READ,
  run: async client => {
    const inbox = await client.select('INBOX');
    if (!inbox.ok) return imapFailure(inbox.reason);
    const { uidNext, exists } = inbox.value;
    const uidValidity = inbox.value.uidValidity ?? 0;
    if (uidNext !== null) return { ok: true, value: { uidValidity, lastUid: uidNext - 1 } };
    // A server that omits UIDNEXT: its newest message's uid stands in.
    if (exists === 0) return { ok: true, value: { uidValidity, lastUid: 0 } };
    const newest = await client.fetchFlags('*');
    if (!newest.ok) return imapFailure(newest.reason);
    return {
      ok: true,
      value: { uidValidity, lastUid: Math.max(0, ...newest.value.map(({ uid }) => uid)) },
    };
  },
};

/** What INBOX holds past `lastUid`, read for this answer and never stored. */
const arrivalsTask = (lastUid: number): MailTask<readonly ImapMessageSummary[]> => ({
  ...READ,
  run: async client => {
    const inbox = await client.ensureSelected('INBOX');
    if (!inbox.ok) return imapFailure(inbox.reason);
    const fetched = await client.fetchSummaries(`${lastUid + 1}:*`);
    if (!fetched.ok) return imapFailure(fetched.reason);
    // `n:*` past the newest uid answers the newest again.
    return { ok: true, value: fetched.value.filter(({ uid }) => uid > lastUid) };
  },
});

/** The INBOX uids whose text holds each of `words`: the body, which no summary carries. */
const bodySearchTask = (
  words: readonly string[],
): MailTask<ReadonlyMap<string, ReadonlySet<number>>> => ({
  ...READ,
  run: async client => {
    const inbox = await client.ensureSelected('INBOX');
    if (!inbox.ok) return imapFailure(inbox.reason);
    const holding = new Map<string, ReadonlySet<number>>();
    for (const word of words) {
      const found = await client.uidSearch({ key: 'TEXT', value: word });
      if (!found.ok) return imapFailure(found.reason);
      holding.set(word, new Set(found.value));
    }
    return { ok: true, value: holding };
  },
});

const NOTHING_ASKED = parseQuery('');

/**
 * What of `query` a new message misses, read from its summary: null when a condition no body could
 * change fails (a sender, a flag, a date), else the plain words found nowhere but its body may hold.
 */
const wordsLeft = (
  query: SearchQuery,
  message: Message,
  subject: string,
): readonly string[] | null => {
  const beyondWords = { ...query, terms: query.terms.filter(({ field }) => field !== 'any') };
  if (!messageMatches(beyondWords, message, subject)) return null;
  return query.terms
    .filter(
      term =>
        term.field === 'any' &&
        !messageMatches({ ...NOTHING_ASKED, terms: [term] }, message, subject),
    )
    .map(({ text }) => text);
};

/**
 * Holds each mailbox's INBOX in IDLE until mail arrives that `query` matches, and answers those
 * conversations. Each round selects every inbox afresh, idles when none holds mail past what was
 * read, and reads only the new mail when one does: its summary answers a sender, a recipient, a
 * subject, a flag or a date here, and the server is asked only for the words a body may hold. New
 * is what an inbox gained after the wait first selected it; at `deadline`, whatever is running is
 * dropped and it fails `WaitTimedOut`. A mailbox whose server fails is answered among `failed` and
 * the rest are watched; when every one fails, so does the wait. What arrived is remembered where it is, and its
 * mailbox syncs on its next read.
 *
 * ponytail: mail that lands before the first SELECT counts as already there. Un-park if a wait is
 * ever seen to miss a message that arrived as it began.
 */
export const waitForMail = Effect.fn('mail.waitForMail')(function* ({
  mailboxes,
  deadline,
  query,
}: {
  readonly mailboxes: readonly InboundAddress[];
  readonly deadline: number;
  readonly query: SearchQuery;
}) {
  const cache = yield* Cache;
  const mail = yield* Mail;
  const failed = new Map<string, MailServerError>();
  const watching = () => mailboxes.filter(({ address }) => !failed.has(address));
  /** Each inbox's mark when the wait first looked, and how far it has been read since. */
  const starts = new Map<string, InboxMark>();
  const reached = new Map<string, number>();
  const arrived = new Map<string, ImapMessageSummary[]>();
  /** Mailboxes whose IDLE connection dropped in the round before. */
  const dropped = new Set<string>();

  /** `asking` of each of `asked`, a failure noted and that mailbox no longer watched. */
  const eachOf = <A>(
    asked: readonly InboundAddress[],
    asking: (mailbox: InboundAddress) => Effect.Effect<A, MailServerError | UsageError>,
  ) =>
    Effect.forEach(
      asked,
      mailbox =>
        asking(mailbox).pipe(
          Effect.map(answer => [{ mailbox, answer }]),
          Effect.catchTag('MailServerError', error =>
            Effect.sync(() => {
              failed.set(error.address, error);
              return [];
            }),
          ),
        ),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map(answers => answers.flat()));

  const extraOf = (): MailboxSummaries =>
    Object.fromEntries(
      [...arrived].flatMap(([address, summaries]) => {
        const start = starts.get(address);
        return start === undefined
          ? []
          : [[address, { inbox: { uidValidity: start.uidValidity, summaries } }] as const];
      }),
    );

  /**
   * The conversations a message among `fresh` gives a match to, asking a server only for words. A
   * message counts only when every copy of it arrived during the wait: one the cache also holds
   * elsewhere (unarchived, or a late copy in another mailbox) is old mail, however new its uid.
   */
  const matching = Effect.fnUntraced(function* (fresh: ReadonlyMap<string, ReadonlySet<number>>) {
    const arrivedAt = new Map(
      [...arrived].flatMap(([address, summaries]) =>
        summaries.map(summary => [`${address}/${summary.uid}`, summary] as const),
      ),
    );
    const summaryOf = ({ mailbox, folder, uidValidity, uid }: Location) =>
      folder === 'inbox' && uidValidity === starts.get(mailbox)?.uidValidity
        ? arrivedAt.get(`${mailbox}/${uid}`)
        : undefined;
    const candidates = (yield* cache.threads(extraOf())).flatMap(thread =>
      thread.messages.flatMap(message => {
        const locations = message.locations ?? [];
        const copy = locations.find(({ mailbox, uid }) => fresh.get(mailbox)?.has(uid) === true);
        const summary = copy === undefined ? undefined : summaryOf(copy);
        const isNew = locations.every(location => summaryOf(location) !== undefined);
        if (copy === undefined || summary === undefined || !isNew) return [];
        // Its own subject: a reply may have changed the one its conversation goes by.
        const left = wordsLeft(query, message, summary.envelope?.subject ?? '');
        return left === null ? [] : [{ thread, copy, left }];
      }),
    );
    const wordsIn = (mailbox: InboundAddress) => [
      ...new Set(
        candidates.flatMap(({ copy, left }) => (copy.mailbox === mailbox.address ? left : [])),
      ),
    ];
    const searched = yield* eachOf(
      watching().filter(mailbox => wordsIn(mailbox).length > 0),
      mailbox => mail.use(mailbox, run => run(bodySearchTask(wordsIn(mailbox)))),
    );
    const bodies = new Map(searched.map(({ mailbox, answer }) => [mailbox.address, answer]));
    const found = candidates.filter(({ copy, left }) =>
      left.every(word => bodies.get(copy.mailbox)?.get(word)?.has(copy.uid) === true),
    );
    return [...new Map(found.map(({ thread }) => [thread.id, thread])).values()];
  });

  const round = Effect.gen(function* () {
    const looks = yield* eachOf(watching(), mailbox => mail.use(mailbox, run => run(lookTask)));
    if (watching().length === 0) {
      const [first] = failed.values();
      if (first !== undefined) return yield* first;
    }
    const grown = looks.filter(({ mailbox: { address }, answer }) => {
      const start = starts.get(address);
      // The first look marks where new starts; a renumbered inbox starts again from where it is.
      if (start === undefined || start.uidValidity !== answer.uidValidity) {
        starts.set(address, answer);
        reached.set(address, answer.lastUid);
        arrived.delete(address);
        return false;
      }
      return answer.lastUid > (reached.get(address) ?? answer.lastUid);
    });
    if (grown.length > 0) {
      const fresh = yield* eachOf(
        grown.map(({ mailbox }) => mailbox),
        mailbox => {
          const lastUid = reached.get(mailbox.address) ?? 0;
          return mail.use(mailbox, run => run(arrivalsTask(lastUid)));
        },
      );
      for (const { mailbox, answer } of fresh) {
        const look = grown.find(({ mailbox: { address } }) => address === mailbox.address);
        const uids = answer.map(({ uid }) => uid);
        reached.set(mailbox.address, Math.max(look?.answer.lastUid ?? 0, ...uids));
        arrived.set(mailbox.address, [...(arrived.get(mailbox.address) ?? []), ...answer]);
      }
      const found = yield* matching(
        new Map(
          fresh.map(({ mailbox, answer }) => [
            mailbox.address,
            new Set(answer.map(({ uid }) => uid)),
          ]),
        ),
      );
      if (found.length > 0) return Option.some(found);
    }
    // More may have landed while that was read: the next round looks again before it idles.
    if (grown.length > 0) return Option.none<readonly ThreadState[]>();
    const idleFrom = yield* Clock.currentTimeMillis;
    // The first inbox to change ends the round, and so does one whose connection dropped, which
    // the next look opens again; one that drops twice running is given up as failed.
    yield* Effect.raceAll(
      looks.map(({ mailbox }) =>
        mail.idleInbox(mailbox).pipe(
          Effect.tap(() => Effect.sync(() => dropped.delete(mailbox.address))),
          Effect.catchTag('MailServerError', error =>
            Effect.sync(() => {
              if (dropped.has(mailbox.address)) failed.set(mailbox.address, error);
              dropped.add(mailbox.address);
            }),
          ),
        ),
      ),
    );
    // A round never comes back sooner than this, whatever a server says: the wait cannot spin.
    const spent = (yield* Clock.currentTimeMillis) - idleFrom;
    if (spent < MIN_ROUND_MS) yield* Effect.sleep(MIN_ROUND_MS - spent);
    return Option.none<readonly ThreadState[]>();
  });
  // The deadline bounds every command, not only the IDLE: a body search can outlast it by minutes.
  const found = yield* round.pipe(
    Effect.repeat({ until: Option.isSome }),
    // Ended early (the deadline, Ctrl-C), an inbox may be idling on a connection that went silent,
    // whose DONE and LOGOUT would wait out a minute's quiet limit: every one is ended unasked.
    Effect.onInterrupt(() => Effect.forEach(mailboxes, mail.abandon, { discard: true })),
    Effect.timeoutOrElse({
      duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
      orElse: () =>
        Effect.fail(new WaitTimedOut({ message: 'No new mail arrived before --wait elapsed' })),
    }),
  );

  const syncedAt = yield* cache.syncedAt(mailboxes);
  const extra = extraOf();
  yield* rememberFound(extra);
  // The cache does not hold what arrived: the next read syncs where it landed.
  yield* Effect.forEach(
    mailboxes.filter(({ address }) => (arrived.get(address) ?? []).length > 0),
    mailbox => cache.markStale(mailbox),
    { discard: true },
  );
  return {
    arrived: Option.getOrElse(found, (): readonly ThreadState[] => []),
    failed: [...failed.values()],
    syncedAt,
  };
});
