import type { MailConnectionFailure, Result } from '../connection.ts';
import { type FolderMatches, matchesFrontier } from './found.ts';
import { hasCriteria, parseQuery, resolveScope, type SearchQuery } from './query.ts';
import type { Folder } from './thread.ts';
import { viewOfQuery } from './views.ts';

/**
 * How long typing must pause before the servers are asked. A search is about 120 commands per word
 * across six mailboxes, so a keystroke that lands inside the pause costs nothing.
 */
export const SEARCH_PAUSE_MS = 1000;

export type ServerSearchAnswer = {
  readonly address: string;
  readonly matches: readonly FolderMatches[];
};

export type ServerSearchFailure = {
  readonly address: string;
  readonly failure: MailConnectionFailure;
};

/** What the servers have been asked, and how far they have got. */
export type ServerSearch = {
  readonly query: string;
  /** `waiting` is the pause; `asking` while any address has not answered; then `settled`. */
  readonly phase: 'waiting' | 'asking' | 'settled';
  readonly asking: readonly string[];
  readonly answers: readonly ServerSearchAnswer[];
  readonly failed: readonly ServerSearchFailure[];
};

/** One address's search: `onMatches` hears each folder as it answers. */
export type SearchOn<T> = (
  mailbox: T,
  request: {
    readonly folders: readonly Folder[];
    readonly query: SearchQuery;
    readonly signal: AbortSignal;
    readonly onMatches: (matches: FolderMatches) => void;
  },
) => Promise<Result<unknown, MailConnectionFailure>>;

/** The next page of what one folder matched, read without searching again. */
export type MoreOn<T> = (
  mailbox: T,
  request: { readonly previous: FolderMatches; readonly signal: AbortSignal },
) => Promise<Result<FolderMatches, MailConnectionFailure>>;

type Plan<T> = {
  readonly query: SearchQuery;
  readonly folders: readonly Folder[];
  readonly mailboxes: readonly T[];
};

/**
 * What a query would ask of whom, or null when it asks nothing: an empty box, a query that only says
 * where, a view's own query, or an address with no mailbox. The vault's drafts are no server's.
 */
export const planOf = <T extends { readonly address: string }>(
  text: string,
  mailboxes: readonly T[],
): Plan<T> | null => {
  if (viewOfQuery(text, mailboxes) !== null) return null;
  const query = parseQuery(text);
  if (!hasCriteria(query)) return null;
  const scope = resolveScope(query, mailboxes);
  if (!scope.ok) return null;
  const folders = scope.value.folders.filter(folder => folder !== 'drafts');
  if (folders.length === 0 || scope.value.mailboxes.length === 0) return null;
  return { query, folders, mailboxes: scope.value.mailboxes };
};

const asFailure = (error: unknown): Result<never, MailConnectionFailure> => ({
  ok: false,
  error: { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
});

/**
 * One search at a time, for a person typing. Typing waits for a pause; anything newer aborts what is
 * running, so its queued tasks and unsent commands never go out, and what it already found never
 * reaches the state. One address failing leaves the others' answers standing.
 */
export const createServerSearch = <T extends { readonly address: string }>({
  mailboxes,
  searchOn,
  moreOn,
  onChange,
  onMatches,
  pauseMs = SEARCH_PAUSE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  readonly mailboxes: () => readonly T[];
  readonly searchOn: SearchOn<T>;
  readonly moreOn: MoreOn<T>;
  readonly onChange: (search: ServerSearch | null) => void;
  /** Every folder's answer as it lands, before the state says so. */
  readonly onMatches?: (address: string, matches: FolderMatches) => void;
  readonly pauseMs?: number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}) => {
  let current: ServerSearch | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (next: ServerSearch | null) => {
    current = next;
    onChange(next);
  };

  const halt = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const ask = (plan: Plan<T>, signal: AbortSignal, targets: readonly T[]) => {
    for (const mailbox of targets) {
      void (async () => {
        const done = await searchOn(mailbox, {
          folders: plan.folders,
          query: plan.query,
          signal,
          onMatches: matches => {
            if (signal.aborted || current === null) return;
            onMatches?.(mailbox.address, matches);
            publish({
              ...current,
              answers: [...current.answers, { address: mailbox.address, matches: [matches] }],
            });
          },
        }).catch(asFailure);
        if (signal.aborted || current === null) return;
        const asking = current.asking.filter(address => address !== mailbox.address);
        publish({
          ...current,
          phase: asking.length === 0 ? 'settled' : 'asking',
          asking,
          failed: done.ok
            ? current.failed
            : [...current.failed, { address: mailbox.address, failure: done.error }],
        });
      })();
    }
  };

  const begin = (query: string, plan: Plan<T>) => {
    halt();
    controller = new AbortController();
    publish({
      query,
      phase: 'asking',
      asking: plan.mailboxes.map(({ address }) => address),
      answers: [],
      failed: [],
    });
    ask(plan, controller.signal, plan.mailboxes);
  };

  return {
    /** What the search in hand asks, typed or asked for. */
    query: () => current?.query ?? null,
    /** The box's text changed: drop what is running, and ask after a pause. */
    type: (text: string) => {
      const query = text.trim();
      if (query === current?.query) return;
      halt();
      const plan = planOf(query, mailboxes());
      if (plan === null) {
        publish(null);
        return;
      }
      publish({ query, phase: 'waiting', asking: [], answers: [], failed: [] });
      timer = setTimer(() => {
        timer = null;
        begin(query, plan);
      }, pauseMs);
    },
    /** Enter, or a link opened: no pause. A search already under way or answered stands. */
    now: (text: string) => {
      const query = text.trim();
      if (query === current?.query && current.phase !== 'waiting') return;
      const plan = planOf(query, mailboxes());
      if (plan === null) {
        halt();
        publish(null);
        return;
      }
      begin(query, plan);
    },
    /** Asks again only the addresses that failed, keeping what the others answered. */
    retry: () => {
      if (current === null || controller === null) return;
      const plan = planOf(current.query, mailboxes());
      if (plan === null) return;
      const failed = new Set(current.failed.map(({ address }) => address));
      const targets = plan.mailboxes.filter(({ address }) => failed.has(address));
      if (targets.length === 0) return;
      publish({
        ...current,
        phase: 'asking',
        asking: targets.map(({ address }) => address),
        failed: [],
      });
      ask(plan, controller.signal, targets);
    },
    /**
     * The next page of the folder that stops soonest, once every address has answered, or null with
     * none read. Superseded, what it read goes the way of the search's other answers, and the matches
     * it named go too. One that fails is no failed search: what every server answered stands, the
     * caller hears of it, and the same page can be asked for again.
     */
    more: async (): Promise<{
      readonly mailbox: T;
      readonly result: Result<unknown, MailConnectionFailure>;
    } | null> => {
      if (current === null || controller === null || current.phase !== 'settled') return null;
      const frontier = matchesFrontier(current.answers);
      const mailbox = mailboxes().find(({ address }) => address === frontier?.mailbox);
      if (frontier === null || mailbox === undefined) return null;
      const { signal } = controller;
      const read = await moreOn(mailbox, { previous: frontier.matches, signal }).catch(asFailure);
      if (signal.aborted || current === null) return null;
      if (!read.ok) return { mailbox, result: read };
      onMatches?.(mailbox.address, read.value);
      publish({
        ...current,
        answers: [...current.answers, { address: mailbox.address, matches: [read.value] }],
      });
      return { mailbox, result: read };
    },
    /** Nothing is being searched any more. */
    stop: () => {
      halt();
      publish(null);
    },
  };
};

/** Every address asked once, for a caller that waits for the whole answer. */
export const askServers = async <T extends { readonly address: string }>({
  plan,
  searchOn,
  signal = new AbortController().signal,
  onMatches,
}: {
  readonly plan: Plan<T>;
  readonly searchOn: SearchOn<T>;
  readonly signal?: AbortSignal;
  readonly onMatches?: (address: string, matches: FolderMatches) => void;
}) => {
  const answers: ServerSearchAnswer[] = [];
  const failed: ServerSearchFailure[] = [];
  await Promise.all(
    plan.mailboxes.map(async mailbox => {
      const done = await searchOn(mailbox, {
        folders: plan.folders,
        query: plan.query,
        signal,
        onMatches: matches => {
          answers.push({ address: mailbox.address, matches: [matches] });
          onMatches?.(mailbox.address, matches);
        },
      });
      if (!done.ok) failed.push({ address: mailbox.address, failure: done.error });
    }),
  );
  return { answers, failed };
};
