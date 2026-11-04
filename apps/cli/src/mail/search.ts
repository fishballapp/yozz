import { type ImapMessageSummary, uidSets } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailTask } from '@yozz.app/mail/connection';
import type { SearchQuery } from '@yozz.app/mail/threads/query';
import { assembleMatches, searchMailbox } from '@yozz.app/mail/threads/search';
import type { FolderSummaries, MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import { FOLDERS, type Folder } from '@yozz.app/mail/threads/thread';
import * as Effect from 'effect/Effect';
import { Cache } from '../cache/cache.ts';
import { usingCache } from '../cache/disk.ts';
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

/**
 * Searches `folders` on every mailbox on its server. Answers the summaries to thread in beside the
 * cache, whether a conversation holds a match, and the mailboxes whose server failed.
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
  return {
    ...assembleMatches(
      answers.flatMap(({ mailbox, answer }) =>
        answer === null ? [] : [{ address: mailbox.address, matches: answer }],
      ),
    ),
    failed,
  };
});

/** What a handle names on the server: a Message-ID, or one uid in one folder. */
type Wanted =
  | { readonly kind: 'messageId'; readonly messageId: string }
  | { readonly kind: 'uid'; readonly uid: number };

/** What `id` asks of `folder` in `mailbox`, whose mark is `uidValidity`; null when nothing. */
const wantedIn = (
  id: string,
  { mailbox, folder, uidValidity }: { mailbox: string; folder: Folder; uidValidity: number },
): Wanted | null => {
  if (id.startsWith('mid/')) return { kind: 'messageId', messageId: id.slice('mid/'.length) };
  const [holder, inFolder, validity, uid] = id.split('/');
  const isHere = holder === mailbox && inFolder === folder && Number(validity) === uidValidity;
  return isHere && Number.isSafeInteger(Number(uid)) ? { kind: 'uid', uid: Number(uid) } : null;
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
    const messageIds = new Set<string>();
    for (const want of wanted) {
      if (want.kind === 'uid') {
        uids.add(want.uid);
        continue;
      }
      messageIds.add(want.messageId);
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
 * Ids the cache does not hold, found on the servers of `mailboxes`: a `mid/` id by its Message-ID in
 * every folder, a location id at its uid. Answered as summaries to thread in beside the cache, which
 * stays the window the syncs keep, and the mailboxes whose server failed.
 */
export const lookUp = Effect.fn('mail.lookUp')(function* ({
  mailboxes,
  ids,
}: {
  readonly mailboxes: readonly InboundAddress[];
  readonly ids: readonly string[];
}) {
  const mail = yield* Mail;
  const cache = yield* Cache;
  if (ids.length === 0) return { extra: {} satisfies MailboxSummaries, failed: [] };
  const { answers, failed } = yield* perMailbox(mailboxes, mailbox =>
    Effect.forEach(
      FOLDERS.filter(folder => folder !== 'drafts'),
      Effect.fnUntraced(function* (folder) {
        const mark = yield* usingCache(() => cache.of(mailbox).folder(folder).getSync());
        const wanted =
          mark === null
            ? []
            : ids.flatMap(
                id =>
                  wantedIn(id, {
                    mailbox: mailbox.address,
                    folder,
                    uidValidity: mark.uidValidity,
                  }) ?? [],
              );
        if (mark === null || wanted.length === 0) return null;
        const summaries = yield* mail.use(mailbox, run =>
          run(lookUpTask({ folderName: mark.name, uidValidity: mark.uidValidity, wanted })),
        );
        return [folder, { uidValidity: mark.uidValidity, summaries }] as const;
      }),
      { concurrency: 1 },
    ),
  );
  // A mailbox that failed answers nothing; the others still do.
  const found = answers.flatMap(({ mailbox, answer }) =>
    answer === null
      ? []
      : [
          [
            mailbox.address,
            Object.fromEntries(answer.filter(entry => entry !== null)) satisfies FolderSummaries,
          ] as const,
        ],
  );
  return { extra: Object.fromEntries(found) satisfies MailboxSummaries, failed };
});
