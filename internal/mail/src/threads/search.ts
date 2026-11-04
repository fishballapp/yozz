import { type ImapMessageSummary, type UidSearchCriterion, uidSets } from '@yozz.app/imap';
import type { MailConnectionFailure, MailTask, Result, RunTask } from '../connection.ts';
import type { MailCache } from './cache.ts';
import { includesText } from './match.ts';
import { hasCriteria, type SearchQuery, type TermField } from './query.ts';
import type { FolderSummaries, MailboxSummaries } from './summaries.ts';
import type { Folder, Location, ThreadState } from './thread.ts';

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
  readonly criteria: readonly UidSearchCriterion[];
  readonly known: readonly number[];
};

/** What a query asks of one folder, the fewest commands first so an empty answer saves the rest. */
const conditionsOf = (
  query: SearchQuery,
  folder: Folder,
  cached: readonly ImapMessageSummary[],
): readonly Condition[] => {
  const single: readonly Condition[] = [
    ...(query.isUnread ? [{ key: 'UNSEEN' } as const] : []),
    ...(query.isStarred ? [{ key: 'FLAGGED' } as const] : []),
    ...query.before.map(date => ({ key: 'BEFORE', date }) as const),
    ...query.after.map(date => ({ key: 'SINCE', date }) as const),
  ].map(criterion => ({ criteria: [criterion], known: [] }));
  const termed = query.terms.map(({ field, text }) => ({
    criteria: CRITERIA_OF[field](text, folder),
    // ponytail: a name is on no server's index, so this is only what this machine has synced.
    known:
      field === 'any'
        ? cached
            .filter(({ attachmentNames }) => attachmentNames.some(name => includesText(name, text)))
            .map(({ uid }) => uid)
        : [],
  }));
  return [...single, ...termed].toSorted((a, b) => a.criteria.length - b.criteria.length);
};

type FolderMatches = {
  readonly folder: Folder;
  readonly uidValidity: number;
  readonly hits: readonly number[];
  /** Of the hits the cache does not hold, read here and never written to it. */
  readonly summaries: readonly ImapMessageSummary[];
  /** The folder matched more than `SEARCH_HITS`, so the oldest were not read. */
  readonly hasMore: boolean;
};

/**
 * One folder: the newest messages meeting every condition, and the summaries the cache lacks of them.
 * Those are read and never stored, as the cache stays one contiguous window, which the incremental
 * sync and the older-mail paging rely on.
 */
const searchFolderTask = ({
  folder,
  folderName,
  uidValidity,
  cached,
  query,
}: {
  readonly folder: Folder;
  readonly folderName: string;
  readonly uidValidity: number;
  readonly cached: readonly ImapMessageSummary[];
  readonly query: SearchQuery;
}): MailTask<FolderMatches> => ({
  priority: 'user',
  effect: 'read',
  retry: true,
  run: async client => {
    const selected = await client.ensureSelected(folderName);
    if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
    if (selected.value.uidValidity !== null && selected.value.uidValidity !== uidValidity) {
      return {
        ok: false,
        error: { kind: 'error', detail: 'a folder was renumbered; sync and search again' },
      };
    }
    let matched: ReadonlySet<number> | null = null;
    for (const { criteria, known } of conditionsOf(query, folder, cached)) {
      const meeting = new Set(known);
      for (const criterion of criteria) {
        const found = await client.uidSearch(criterion);
        if (!found.ok) return { ok: false, error: { kind: 'imap', reason: found.reason } };
        for (const uid of found.value) meeting.add(uid);
      }
      matched = matched === null ? meeting : matched.intersection(meeting);
      // Nothing can come back from here on, so a throttling server is asked no more.
      if (matched.size === 0) break;
    }
    const all = [...(matched ?? [])].toSorted((a, b) => b - a);
    const hits = all.slice(0, SEARCH_HITS);
    const held = new Set(cached.map(({ uid }) => uid));
    const summaries: ImapMessageSummary[] = [];
    for (const set of uidSets(hits.filter(uid => !held.has(uid)))) {
      const fetched = await client.fetchSummaries(set);
      if (!fetched.ok) return { ok: false, error: { kind: 'imap', reason: fetched.reason } };
      summaries.push(...fetched.value);
    }
    return {
      ok: true,
      value: { folder, uidValidity, hits, summaries, hasMore: all.length > hits.length },
    };
  },
});

/**
 * `folders` of one mailbox on its server, in turn, over its one connection. A folder this mailbox
 * has no mark for holds nothing to find, and the vault's drafts are no server's to search.
 */
export const searchMailbox = async ({
  run,
  cache,
  folders,
  query,
}: {
  readonly run: RunTask;
  readonly cache: MailCache;
  readonly folders: readonly Folder[];
  readonly query: SearchQuery;
}): Promise<Result<readonly FolderMatches[], MailConnectionFailure>> => {
  if (!hasCriteria(query)) return { ok: true, value: [] };
  const matches: FolderMatches[] = [];
  for (const folder of folders.filter(candidate => candidate !== 'drafts')) {
    const folderCache = cache.folder(folder);
    const [mark, cached] = await Promise.all([folderCache.getSync(), folderCache.listSummaries()]);
    if (mark === null) continue;
    const answered = await run(
      searchFolderTask({
        folder,
        folderName: mark.name,
        uidValidity: mark.uidValidity,
        cached,
        query,
      }),
    );
    if (!answered.ok) return answered;
    matches.push(answered.value);
  }
  return { ok: true, value: matches };
};

const hitKey = ({ mailbox, folder, uid }: Omit<Location, 'uidValidity'>) =>
  `${mailbox}/${folder}/${uid}`;

/**
 * What the mailboxes that answered add up to: the summaries to thread in beside the cache, whether
 * a conversation holds a match, and whether any folder had more than were read.
 */
export const assembleMatches = (
  answers: readonly {
    readonly address: string;
    readonly matches: readonly FolderMatches[];
  }[],
) => {
  const hits = new Set(
    answers.flatMap(({ address, matches }) =>
      matches.flatMap(({ folder, hits }) =>
        hits.map(uid => hitKey({ mailbox: address, folder, uid })),
      ),
    ),
  );
  return {
    extra: Object.fromEntries(
      answers.map(({ address, matches }) => [
        address,
        Object.fromEntries(
          matches.map(({ folder, uidValidity, summaries }) => [folder, { uidValidity, summaries }]),
        ) satisfies FolderSummaries,
      ]),
    ) satisfies MailboxSummaries,
    hasMoreMatches: answers.some(({ matches }) => matches.some(({ hasMore }) => hasMore)),
    isHit: (thread: ThreadState) =>
      thread.messages.some(message =>
        (message.locations ?? []).some(location => hits.has(hitKey(location))),
      ),
  };
};
