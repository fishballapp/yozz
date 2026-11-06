import {
  type ImapMessageSummary,
  type ImapResult,
  type UidSearchCriterion,
  uidSets,
} from '@yozz.app/imap';
import type {
  MailClient,
  MailConnectionFailure,
  MailTask,
  Result,
  RunTask,
} from '../connection.ts';
import type { MailCache } from './cache.ts';
import type { FolderMatches } from './found.ts';
import { includesText } from './match.ts';
import { hasCriteria, type SearchQuery, type TermField } from './query.ts';
import { parseInternalDate } from './summaries.ts';
import type { Folder } from './thread.ts';

/** How many matches a query reads in each folder, newest first: one sync window's worth. */
export const SEARCH_HITS = 200;

/** Each field is its own command and the client unions them: Forward Email's `OR` answers less than its parts. */
const CRITERIA_OF: Readonly<
  Record<TermField, (value: string, folder: Folder) => readonly UidSearchCriterion[]>
> = {
  any: (value, folder) => [
    { key: 'SUBJECT', value },
    { key: 'FROM', value },
    { key: 'TO', value },
    { key: 'CC', value },
    { key: 'HEADER', header: 'Reply-To', value },
    { key: 'TEXT', value },
    // Only your own copy of what you sent can hold a Bcc line.
    ...(folder === 'sent' ? [{ key: 'BCC', value } as const] : []),
  ],
  from: value => [{ key: 'FROM', value }],
  to: value => [
    { key: 'TO', value },
    { key: 'CC', value },
  ],
  subject: value => [{ key: 'SUBJECT', value }],
};

/** One thing a message must satisfy: any of these commands, or being one of `known`. */
type Condition = {
  readonly commands: readonly (readonly UidSearchCriterion[])[];
  readonly known: readonly number[];
};

/**
 * What a query asks of one folder, the fewest commands first so an empty answer saves the rest. The
 * flag and date keys are not commands of their own: a command's keys are ANDed, so they ride on the
 * first term's commands. A term a cached attachment name widens cannot carry them, as that name
 * never met the server.
 */
const conditionsOf = (
  query: SearchQuery,
  folder: Folder,
  cached: readonly ImapMessageSummary[],
): readonly Condition[] => {
  const filters: readonly UidSearchCriterion[] = [
    ...(query.isUnread ? [{ key: 'UNSEEN' } as const] : []),
    ...(query.isStarred ? [{ key: 'FLAGGED' } as const] : []),
    ...query.before.map(date => ({ key: 'BEFORE', date }) as const),
    ...query.after.map(date => ({ key: 'SINCE', date }) as const),
  ];
  const termed = query.terms
    .map(({ field, text }) => ({
      commands: CRITERIA_OF[field](text, folder).map(criterion => [criterion]),
      // ponytail: a name is on no server's index, so this is only what this machine has synced.
      known:
        field === 'any'
          ? cached
              .filter(({ attachmentNames }) =>
                attachmentNames.some(name => includesText(name, text)),
              )
              .map(({ uid }) => uid)
          : [],
    }))
    // Fewest commands first, and of equal ones a term only the server answers first: it can carry
    // the filters, and it is the one that can come back empty and end the search early.
    .toSorted(
      (a, b) =>
        a.commands.length - b.commands.length ||
        Number(a.known.length > 0) - Number(b.known.length > 0),
    );
  if (filters.length === 0) return termed;
  const carrier = termed.findIndex(({ known }) => known.length === 0);
  if (carrier === -1) return [{ commands: [filters], known: [] }, ...termed];
  return termed.map((condition, index) =>
    index === carrier
      ? { ...condition, commands: condition.commands.map(command => [...filters, ...command]) }
      : condition,
  );
};

const CANCELLED = { ok: false, error: { kind: 'cancelled' } } as const;

/**
 * One command, as a task of its own: the connection is one per mailbox, so other work someone asked
 * for waits behind this command rather than behind the rest of the search. Whatever ran in between
 * may have selected another folder, so each selects its own (no command when it still is) and checks
 * it has not been renumbered.
 */
const commandTask = <T>(
  { folderName, uidValidity, signal }: FolderInScope,
  command: (client: MailClient) => Promise<ImapResult<T>>,
): MailTask<T> => ({
  priority: 'user',
  effect: 'read',
  retry: true,
  ...(signal === undefined ? {} : { signal }),
  run: async client => {
    const selected = await client.ensureSelected(folderName);
    if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
    if (selected.value.uidValidity !== null && selected.value.uidValidity !== uidValidity) {
      return {
        ok: false,
        error: { kind: 'error', detail: 'a folder was renumbered; sync and search again' },
      };
    }
    const done = await command(client);
    return done.ok
      ? { ok: true, value: done.value }
      : { ok: false, error: { kind: 'imap', reason: done.reason } };
  },
});

type FolderInScope = {
  readonly folder: Folder;
  readonly folderName: string;
  readonly uidValidity: number;
  readonly cached: readonly ImapMessageSummary[];
  readonly signal: AbortSignal | undefined;
};

/** One folder: every message meeting every condition, and the newest of them read. */
const searchFolder = async (
  run: RunTask,
  query: SearchQuery,
  inScope: FolderInScope,
): Promise<Result<FolderMatches, MailConnectionFailure>> => {
  const { folder, cached, signal } = inScope;
  let matched: ReadonlySet<number> | null = null;
  for (const { commands, known } of conditionsOf(query, folder, cached)) {
    const meeting = new Set(known);
    for (const command of commands) {
      if (signal?.aborted === true) return CANCELLED;
      const found = await run(commandTask(inScope, client => client.uidSearch(command)));
      if (!found.ok) return found;
      for (const uid of found.value) meeting.add(uid);
    }
    matched = matched === null ? meeting : matched.intersection(meeting);
    // Nothing can come back from here on, so a throttling server is asked no more.
    if (matched.size === 0) break;
  }
  return readHits(
    run,
    inScope,
    [...(matched ?? [])].toSorted((a, b) => b - a),
  );
};

/**
 * The newest `SEARCH_HITS` of `matches`, and the summaries of them the cache lacks: read here and
 * never stored, as the cache stays one contiguous window, which the incremental sync and the
 * older-mail paging rely on. The rest wait, named, for someone to ask.
 */
const readHits = async (
  run: RunTask,
  inScope: FolderInScope,
  matches: readonly number[],
): Promise<Result<FolderMatches, MailConnectionFailure>> => {
  const { folder, folderName, uidValidity, cached, signal } = inScope;
  const hits = matches.slice(0, SEARCH_HITS);
  const rest = matches.slice(SEARCH_HITS);
  const held = new Set(cached.map(({ uid }) => uid));
  const summaries: ImapMessageSummary[] = [];
  for (const set of uidSets(hits.filter(uid => !held.has(uid)))) {
    if (signal?.aborted === true) return CANCELLED;
    const fetched = await run(commandTask(inScope, client => client.fetchSummaries(set)));
    if (!fetched.ok) return fetched;
    summaries.push(...fetched.value);
  }
  // Lowest first: that one may have been expunged since the search, or carry a date that doesn't parse.
  const dateOf = new Map(
    [...summaries, ...cached].map(({ uid, internalDate }) => [uid, internalDate]),
  );
  const [reachedAt = null] = hits
    .toReversed()
    .flatMap(uid => parseInternalDate(dateOf.get(uid)) ?? []);
  return {
    ok: true,
    value: {
      folder,
      folderName,
      uidValidity,
      hits,
      summaries,
      rest,
      reachedAt: rest.length === 0 ? null : reachedAt,
    },
  };
};

/** The next page of a folder's matches: the server has already named them, so nothing is searched again. */
export const readMoreMatches = async ({
  run,
  cache,
  previous: { folder, folderName, uidValidity, rest },
  signal,
}: {
  readonly run: RunTask;
  readonly cache: MailCache;
  readonly previous: FolderMatches;
  readonly signal?: AbortSignal;
}): Promise<Result<FolderMatches, MailConnectionFailure>> =>
  readHits(
    run,
    {
      folder,
      folderName,
      uidValidity,
      cached: await cache.folder(folder).listSummaries(),
      signal,
    },
    rest,
  );

/**
 * `folders` of one mailbox on its server, in turn, over its one connection. A folder this mailbox
 * has no mark for holds nothing to find, and the vault's drafts are no server's to search. `signal`
 * stops it between commands and drops what it has queued; a command on the wire finishes, unheard.
 * The cache is read first, so nothing but a command's answer stands between one command and the next.
 */
export const searchMailbox = async ({
  run,
  cache,
  folders,
  query,
  signal,
  onMatches,
}: {
  readonly run: RunTask;
  readonly cache: MailCache;
  readonly folders: readonly Folder[];
  readonly query: SearchQuery;
  readonly signal?: AbortSignal;
  /** Hears each folder as it answers, so a slow one holds nothing back. */
  readonly onMatches?: (matches: FolderMatches) => void;
}): Promise<Result<readonly FolderMatches[], MailConnectionFailure>> => {
  if (!hasCriteria(query)) return { ok: true, value: [] };
  const inScope = await Promise.all(
    folders
      .filter(candidate => candidate !== 'drafts')
      .map(async folder => {
        const folderCache = cache.folder(folder);
        const [mark, cached] = await Promise.all([
          folderCache.getSync(),
          folderCache.listSummaries(),
        ]);
        return mark === null
          ? []
          : [{ folder, folderName: mark.name, uidValidity: mark.uidValidity, cached, signal }];
      }),
  );
  const matches: FolderMatches[] = [];
  for (const folder of inScope.flat()) {
    if (signal?.aborted === true) return CANCELLED;
    const answered = await searchFolder(run, query, folder);
    if (!answered.ok) return answered;
    matches.push(answered.value);
    onMatches?.(answered.value);
  }
  if (signal?.aborted === true) return CANCELLED;
  return { ok: true, value: matches };
};
