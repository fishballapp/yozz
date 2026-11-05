import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import type { FolderSync } from '@yozz.app/mail/threads/cache';
import {
  applyOps,
  canMoveTo,
  flagTargets,
  MOVE_SOURCES,
  type MoveTarget,
  type PendingChange,
  type PendingOp,
} from '@yozz.app/mail/threads/reconcile';
import { type MovedCopy, moveMessages, recordMoves, setFlag } from '@yozz.app/mail/threads/sync';
import {
  type Folder,
  isArchived,
  isServerCopy,
  isTrashed,
  type Location,
  renumberedText,
  type ThreadState,
} from '@yozz.app/mail/threads/thread';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { Cache, MailboxLayer } from '../cache/cache.ts';
import { usingCache } from '../cache/disk.ts';
import { PartialFailure, reportFailure, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { Mail, mailServerError } from './mail.ts';
import { NOTICE } from './rows.ts';
import { locate } from './search.ts';

const NOT_ON_SERVER =
  'No copy of this conversation is on a mail server to change; a message just sent has one once its Sent copy syncs.';

/** One field's write: what it changes, which copies it addresses, and whether a thread needs it. */
type Write = {
  readonly change: PendingChange;
  readonly picks: (folder: Folder) => boolean;
  readonly isNeeded: (thread: ThreadState) => boolean;
  /** Why a conversation needs no move; null when it does. */
  readonly unmoved?: (thread: ThreadState) => string | null;
};

const flagWrite = (key: 'isUnread' | 'isStarred', value: boolean): Write => ({
  change: { kind: 'flag', key, value },
  // A flag applies to every copy of the conversation.
  picks: () => true,
  isNeeded: thread => thread[key] !== value,
});

/** Why `to` moves nothing of `thread`, in the WebMCP tools' words. */
const unmovedBy =
  (to: MoveTarget) =>
  (thread: ThreadState): string | null => {
    if (to === 'archive' && isArchived(thread)) return 'already archived';
    if (to === 'trash' && isTrashed(thread)) return 'already in the trash';
    if (to === 'inbox' && !isArchived(thread) && !isTrashed(thread)) return 'already in the inbox';
    if (!canMoveTo(thread.folders, to)) return `nothing to move to ${to}`;
    return null;
  };

const moveWrite = (to: MoveTarget): Write => {
  const unmoved = unmovedBy(to);
  return {
    change: { kind: 'move', to },
    picks: folder => MOVE_SOURCES[to].includes(folder),
    isNeeded: thread => unmoved(thread) === null,
    unmoved,
  };
};

const serverCopies = (thread: ThreadState) =>
  thread.messages.flatMap(message => (message.locations ?? []).filter(isServerCopy));

export const updateCommand = Command.make(
  'update',
  {
    ids: Argument.String('id').pipe(
      Argument.withDescription('Up to 50 conversation or message ids from `yozz list`'),
      Argument.between(1, 50),
    ),
    read: Flag.Boolean('read').pipe(Flag.withDescription('Mark read'), Flag.withDefault(false)),
    unread: Flag.Boolean('unread').pipe(
      Flag.withDescription('Mark unread'),
      Flag.withDefault(false),
    ),
    star: Flag.Boolean('star').pipe(Flag.withDescription('Star'), Flag.withDefault(false)),
    unstar: Flag.Boolean('unstar').pipe(
      Flag.withDescription('Remove the star'),
      Flag.withDefault(false),
    ),
    move: Flag.Literals('move', ['inbox', 'archive', 'trash']).pipe(
      Flag.withDescription('Move every copy of the conversation'),
      Flag.optional,
    ),
  },
  Effect.fn('mail.update')(function* ({ ids, read, unread, star, unstar, move }) {
    if ((read && unread) || (star && unstar)) {
      return yield* new UsageError({
        message: 'Give --read or --unread, and --star or --unstar, not both',
      });
    }
    const writes = [
      ...(read || unread ? [flagWrite('isUnread', unread)] : []),
      ...(star || unstar ? [flagWrite('isStarred', star)] : []),
      ...(Option.isSome(move) ? [moveWrite(move.value)] : []),
    ];
    if (writes.length === 0) {
      return yield* new UsageError({
        message: 'Nothing to change: give --read, --unread, --star, --unstar or --move',
      });
    }
    const mail = yield* Mail;
    const cache = yield* Cache;

    // Every mailbox holding them syncs first, however fresh, so no write acts on a location
    // yozz.app changed a minute ago; the rest only when an id is cached nowhere. A search hit
    // outside the cached window is read from where the search found it.
    const located = yield* locate({ ids, force: true });
    const { entries } = located;
    // A mailbox that cannot sync is not written: its rows carry the failure.
    const unsynced = new Map(located.unsynced.map(error => [error.address, error] as const));
    const found = entries.flatMap(({ thread }) => (thread === null ? [] : [thread]));
    const touched = new Set(found.flatMap(serverCopies).map(({ mailbox }) => mailbox));

    const ops: PendingOp[] = [];
    /** A conversation a write refused, with why; the writes after it leave it out. */
    const refused = new Map<string, { readonly code: string; readonly message: string }>();
    const offServer = new Set<string>();

    /** One command per mailbox and folder over every conversation `write` changes. */
    const apply = Effect.fnUntraced(function* (write: Write) {
      const changing = found.filter(thread => !refused.has(thread.id) && write.isNeeded(thread));
      for (const thread of changing) {
        if (serverCopies(thread).length === 0) offServer.add(thread.id);
      }
      yield* Effect.forEach(
        mail.mailboxes,
        Effect.fnUntraced(function* (mailbox: InboundAddress) {
          const work = changing.flatMap(thread => {
            const copies = serverCopies(thread).filter(
              ({ mailbox: holder, folder }) => holder === mailbox.address && write.picks(folder),
            );
            return copies.length === 0 ? [] : [{ thread, copies }];
          });
          if (work.length === 0) return;
          const failedSync = unsynced.get(mailbox.address);
          if (failedSync !== undefined) {
            for (const { thread } of work) {
              refused.set(thread.id, { code: failedSync._tag, message: failedSync.message });
            }
            return;
          }
          const res = yield* usingCache(() =>
            command(
              mailbox,
              write,
              work.flatMap(({ copies }) => copies),
            ),
          );
          if (!res.ok) {
            const error = mailServerError(
              { address: mailbox.address, host: mailbox.imap.host },
              res.error,
            );
            for (const { thread } of work) {
              refused.set(thread.id, { code: error._tag, message: error.message });
            }
            return;
          }
          // A copy a search found moves with it, or the next read would look where it was.
          yield* cache.found(mailbox).refile(res.value.moved);
          // No COPYUID, a destination no sync has read (just created), or a copy the cache never
          // held (a search hit): the next read syncs first, so a list shows where it went.
          if (!res.value.isRecorded) yield* cache.markStale(mailbox);
          ops.push(
            ...work.map(({ thread }) => ({
              id: `${mailbox.address}\n${thread.id}\n${ops.length}`,
              mailbox: mailbox.address,
              threadId: thread.id,
              change: write.change,
              retireAtSyncSeq: null,
            })),
          );
        }),
        { concurrency: 'unbounded', discard: true },
      );
    });

    /** The write itself, written into the cache as it lands, so the next list shows it. */
    const command = async (
      mailbox: InboundAddress,
      write: Write,
      copies: readonly Location[],
    ): Promise<
      Result<
        {
          /** Whether the cache now holds where every copy went. */
          readonly isRecorded: boolean;
          readonly moved: readonly MovedCopy[];
        },
        MailConnectionFailure
      >
    > => {
      const mailboxCache = cache.of(mailbox);
      const folders = new Set(copies.map(({ folder }) => folder));
      const marks = new Map<Folder, FolderSync | null>(
        await Promise.all(
          [...folders].map(
            async folder => [folder, await mailboxCache.folder(folder).getSync()] as const,
          ),
        ),
      );
      // `flagTargets` refuses these too, by throwing; said here as the failure they are.
      for (const { folder, uidValidity } of copies) {
        const mark = marks.get(folder);
        if (mark == null) {
          return { ok: false, error: { kind: 'error', detail: `${folder} has not synced` } };
        }
        if (mark.uidValidity !== uidValidity) {
          return { ok: false, error: { kind: 'error', detail: renumberedText(folder) } };
        }
      }
      const targets = flagTargets(copies, marks);
      const run = mail.runOn(mailbox);
      const { change } = write;
      if (change.kind === 'flag') {
        const flag = change.key === 'isUnread' ? '\\Seen' : '\\Flagged';
        const on = change.key === 'isUnread' ? !change.value : change.value;
        const flagged = await setFlag(run, mailboxCache, targets, flag, on);
        return flagged.ok ? { ok: true, value: { isRecorded: true, moved: [] } } : flagged;
      }
      const moved = await moveMessages(run, targets, change.to);
      if (!moved.ok) return moved;
      const cached = new Map(
        await Promise.all(
          [...folders].map(
            async folder =>
              [
                folder,
                new Set((await mailboxCache.folder(folder).listSummaries()).map(({ uid }) => uid)),
              ] as const,
          ),
        ),
      );
      const isEveryCached = moved.value.every(({ from }) => cached.get(from.folder)?.has(from.uid));
      const { isComplete } = await recordMoves(mailboxCache, moved.value);
      return { ok: true, value: { isRecorded: isComplete && isEveryCached, moved: moved.value } };
    };

    for (const write of writes) yield* apply(write);

    const rows = entries.map(({ id, thread }) => {
      if (thread === null) {
        return {
          id,
          error: {
            code: 'NotFound',
            message: `Nothing cached is ${id}; search with yozz list --query`,
          },
        };
      }
      const [after = thread] = applyOps([thread], ops);
      const note = (() => {
        if (offServer.has(thread.id)) return NOT_ON_SERVER;
        return writes.find(write => write.unmoved !== undefined)?.unmoved?.(thread) ?? null;
      })();
      const error = refused.get(thread.id);
      return {
        id,
        isUnread: after.isUnread,
        isStarred: after.isStarred,
        folders: after.folders,
        ...(note === null ? {} : { note }),
        ...(error === undefined ? {} : { error }),
      };
    });
    const output = {
      notice: NOTICE,
      threads: rows,
      syncedAt: yield* cache.syncedAt(mail.mailboxes.filter(({ address }) => touched.has(address))),
    };
    const failed = rows.filter(row => 'error' in row).length;
    if (failed > 0) {
      return yield* new PartialFailure({
        message: `${failed} of ${rows.length} conversation(s) were not updated; each says why`,
        output,
      });
    }
    yield* printJson(output);
  }, reportFailure),
).pipe(
  Command.withShortDescription('Mark read or unread, star, or move conversations'),
  Command.withDescription(`Mark conversations read or unread, star or unstar them, or move them; only what is given changes, on every copy of the conversation in every account. Syncs the accounts holding them
first, every account only when an id isn't cached, then writes one command per account and folder;
a mail list --query found outside the cache is changed where it was found, with no search. Each row says the state the conversation ends
in. When some fail, the error is PartialFailure and the rows still print on stdout, each failed one
with its own error: a conversation on an address whose mail server failed is not written, and its row
says why.

Output:
  {
    "threads": [
      { "id": "mid/<01J9XYZ@stripe.com>", "isUnread": false, "isStarred": false, "folders": ["archive"] }
    ],
    "syncedAt": { "jason@fishball.ltd": "2026-10-30T09:41:07.000Z" }
  }`),
  Command.withExamples([
    {
      command: "yozz update 'mid/<01J9XYZ@stripe.com>' --read --move archive",
      description: 'Read and archived',
    },
  ]),
  Command.provide(MailboxLayer),
);
