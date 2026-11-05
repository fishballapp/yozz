import type { ImapMessageSummary } from '@yozz.app/imap';
import type { OlderFrontier } from './paging.ts';
import type { FolderSummaries, MailboxSummaries } from './summaries.ts';
import type { MovedCopy } from './sync.ts';
import type { Folder, Location, ThreadState } from './thread.ts';

/**
 * What server searches found, apart from asking: this is in the entry bundle and `search.ts`, which
 * speaks IMAP, is not. Found mail is read and never stored, as the cache stays one contiguous window.
 */

export type FolderMatches = {
  readonly folder: Folder;
  readonly uidValidity: number;
  readonly hits: readonly number[];
  /** Of the hits the cache does not hold, read here and never written to it. */
  readonly summaries: readonly ImapMessageSummary[];
  /** What `SELECT` takes, for reading the rest. */
  readonly folderName: string;
  /** Older matches than `hits`, newest first: the server has named them, and they are not read yet. */
  readonly rest: readonly number[];
  /** When the lowest of `hits` arrived, while `rest` holds more. A list can't say what lies below it. */
  readonly reachedAt: number | null;
};

/** Laid over what earlier searches found, by uid; a folder renumbered since starts again. */
export const withFound = (found: FolderSummaries, matches: FolderMatches): FolderSummaries => {
  const read = found[matches.folder];
  const held = read?.uidValidity === matches.uidValidity ? read.summaries : [];
  const byUid = new Map([...held, ...matches.summaries].map(summary => [summary.uid, summary]));
  return {
    ...found,
    [matches.folder]: { uidValidity: matches.uidValidity, summaries: [...byUid.values()] },
  };
};

/** A found copy's flag, after a write that reached it. Found mail is no sync's to refresh. */
export const foundAfterFlag = (
  found: FolderSummaries,
  folder: Folder,
  uids: readonly number[],
  flag: string,
  isOn: boolean,
): FolderSummaries => {
  const read = found[folder];
  if (read === undefined) return found;
  const touched = new Set(uids);
  return {
    ...found,
    [folder]: {
      ...read,
      summaries: read.summaries.map(summary =>
        touched.has(summary.uid)
          ? {
              ...summary,
              flags: isOn
                ? [...new Set([...summary.flags, flag])]
                : summary.flags.filter(candidate => candidate !== flag),
            }
          : summary,
      ),
    },
  };
};

/** Found copies where a move left them; one the server did not place is gone until it is found again. */
export const foundAfterMoves = (
  found: FolderSummaries,
  moves: readonly MovedCopy[],
): FolderSummaries =>
  moves.reduce<FolderSummaries>((current, { from, to }) => {
    const read = current[from.folder];
    const moved = read?.summaries.find(({ uid }) => uid === from.uid);
    if (read === undefined || moved === undefined) return current;
    const left = {
      ...current,
      [from.folder]: {
        ...read,
        summaries: read.summaries.filter(({ uid }) => uid !== from.uid),
      },
    };
    if (to === null) return left;
    const there = left[to.folder];
    return {
      ...left,
      [to.folder]: {
        uidValidity: to.uidValidity,
        summaries: [
          ...(there?.uidValidity === to.uidValidity ? there.summaries : []),
          { ...moved, uid: to.uid },
        ],
      },
    };
  }, found);

/** A flag write's change, on every copy it reached that a search had found. */
export const flagAfterWrite = (
  found: FolderSummaries,
  targets: readonly { readonly folder: Folder; readonly uids: readonly number[] }[],
  { key, value }: { readonly key: 'isUnread' | 'isStarred'; readonly value: boolean },
): FolderSummaries =>
  targets.reduce(
    (current, { folder, uids }) =>
      key === 'isUnread'
        ? foundAfterFlag(current, folder, uids, '\\Seen', !value)
        : foundAfterFlag(current, folder, uids, '\\Flagged', value),
    found,
  );

/** Any folder matched more than it read. */
export const hasMoreMatches = (
  answers: readonly { readonly matches: readonly Pick<FolderMatches, 'rest'>[] }[],
) => answers.some(({ matches }) => matches.some(({ rest }) => rest.length > 0));

/** Each folder's newest answer: a page of older matches comes after the one before it. */
const newestAnswers = (
  answers: readonly { readonly address: string; readonly matches: readonly FolderMatches[] }[],
) => [
  ...new Map(
    answers.flatMap(({ address, matches }) =>
      matches.map(match => [`${address}/${match.folder}`, { address, match }] as const),
    ),
  ).values(),
];

/**
 * The folder whose read matches stop soonest, of those with more to read, or null when none has. As
 * with a list of what is synced, a row at or below where it stops could hide a match above it.
 */
export const matchesFrontier = (
  answers: readonly { readonly address: string; readonly matches: readonly FolderMatches[] }[],
): (OlderFrontier & { readonly matches: FolderMatches }) | null =>
  newestAnswers(answers)
    .flatMap(({ address, match }) =>
      match.rest.length > 0 && match.reachedAt !== null
        ? [{ mailbox: address, folder: match.folder, reachedAt: match.reachedAt, matches: match }]
        : [],
    )
    .toSorted((a, b) => b.reachedAt - a.reachedAt)[0] ?? null;

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
    hasMoreMatches: hasMoreMatches(answers),
    isHit: (thread: ThreadState) =>
      thread.messages.some(message =>
        (message.locations ?? []).some(location => hits.has(hitKey(location))),
      ),
  };
};
