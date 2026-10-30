import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { FolderSync } from '@yozz.app/mail/threads/cache';
import type { ThreadState } from '@yozz.app/mail/threads/thread';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { Cache } from '../cache/cache.ts';
import { usingCache } from '../cache/disk.ts';
import { type MailServerError, WaitTimedOut } from '../errors.ts';
import { Mail } from './mail.ts';

/** The shortest round of waiting, so a server that keeps saying "changed" is not asked in a loop. */
const MIN_ROUND_MS = 1_000;

/** What each account's inbox held when it last synced. */
const inboxMarks = (accounts: readonly InboundAddress[]) =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    return new Map(
      yield* Effect.forEach(
        accounts,
        account =>
          usingCache(() => cache.of(account).folder('inbox').getSync()).pipe(
            Effect.map(mark => [account.address, mark] as const),
          ),
        { concurrency: 'unbounded' },
      ),
    );
  });

/** A message in an inbox past where that inbox stood at `marks`. */
const arrivedSince =
  (marks: ReadonlyMap<string, FolderSync | null>) =>
  (thread: ThreadState): boolean =>
    thread.messages.some(message =>
      (message.locations ?? []).some(({ account, folder, uidValidity, uid }) => {
        if (folder !== 'inbox') return false;
        const mark = marks.get(account);
        if (mark === undefined) return false;
        return mark === null || uidValidity !== mark.uidValidity || uid > mark.lastUid;
      }),
    );

/**
 * Holds each account's INBOX in IDLE until mail arrives that `rowsOf` keeps, syncing after every
 * change the server reports, and answers those conversations. New is what an inbox gained after the
 * sync this starts with; past `deadline` with nothing, it fails `WaitTimedOut`. An account whose sync
 * fails is answered among `failed` and the rest are watched; when every one fails, so does the wait.
 *
 * ponytail: mail that lands during that first sync counts as already there. Un-park if a wait is
 * ever seen to miss a message that arrived as it began.
 */
export const waitForMail = Effect.fn('mail.waitForMail')(function* <E>({
  accounts,
  deadline,
  rowsOf,
}: {
  readonly accounts: readonly InboundAddress[];
  readonly deadline: number;
  /** The conversations to answer, searching the servers of `watched`. */
  readonly rowsOf: (
    watched: readonly InboundAddress[],
    isWanted: (thread: ThreadState) => boolean,
  ) => Effect.Effect<readonly ThreadState[], E, Cache | Mail>;
}) {
  const cache = yield* Cache;
  const mail = yield* Mail;
  const failed = new Map<string, MailServerError>();
  const noteFailures = (errors: readonly MailServerError[]) => {
    for (const error of errors) failed.set(error.address, error);
  };
  noteFailures((yield* cache.syncSome(accounts, { force: true })).failed);
  const watched = accounts.filter(({ address }) => !failed.has(address));
  const isNew = arrivedSince(yield* inboxMarks(watched));

  const round = Effect.gen(function* () {
    const found = yield* rowsOf(watched, isNew);
    if (found.length > 0) return Option.some(found);
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* new WaitTimedOut({ message: 'No new mail arrived before --wait elapsed' });
    }
    const marks = yield* inboxMarks(watched);
    // The first inbox to change ends the round; one that cannot be watched leaves it to the others.
    yield* Effect.raceAll(
      watched.map(account => mail.waitForInbox(account, marks.get(account.address)?.lastUid ?? 0)),
    ).pipe(Effect.timeoutOrElse({ duration: deadline - now, orElse: () => Effect.void }));
    // A round never comes back sooner than this, whatever a server says: the wait cannot spin.
    const spent = (yield* Clock.currentTimeMillis) - now;
    if (spent < MIN_ROUND_MS) {
      yield* Effect.sleep(Math.min(MIN_ROUND_MS - spent, Math.max(0, deadline - now - spent)));
    }
    noteFailures((yield* cache.sync(watched, { force: true })).failed);
    return Option.none<readonly ThreadState[]>();
  });
  const found = yield* round.pipe(Effect.repeat({ until: Option.isSome }));
  return {
    arrived: Option.getOrElse(found, (): readonly ThreadState[] => []),
    failed: [...failed.values()],
  };
});
