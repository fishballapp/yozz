import {
  type CopyUid,
  copiedUid,
  type ImapClient,
  type ImapMessageSummary,
  uidSets,
} from '@yozz.app/imap';
import { ensureMailbox, resolveFolders } from '../addresses/mailboxes.ts';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import { type FetchedBody, parseBody } from './bodies.ts';
import type { FolderCache, FolderSync, MailCache } from './cache.ts';
import type { FolderSummaries } from './summaries.ts';
import { FOLDERS, type Folder, type Location } from './thread.ts';

export type AccountSyncState =
  | { readonly status: 'idle' }
  | { readonly status: 'syncing' }
  | {
      readonly status: 'synced';
      readonly at: number;
      /** Folders whose oldest message is cached. */
      readonly complete: readonly Folder[];
    }
  | {
      readonly status: 'failed';
      readonly failure: MailConnectionFailure;
      readonly at: number;
      /** The cache was dropped (a `UIDVALIDITY` change) before this sync failed, so the in-memory threads name invalid uids. */
      readonly invalidated?: boolean;
    };

/** A window in message sequence numbers, which are dense; uids are not. See DECISIONS.md, "A sync window is 200 sequence numbers". */
const WINDOW = 200;

type FolderOutcome =
  | {
      readonly ok: true;
      readonly summaries: readonly ImapMessageSummary[];
      /** The first sync reached the whole folder. */
      readonly complete: boolean;
      /** What the uids in `summaries` are meaningful under. */
      readonly uidValidity: number;
    }
  | { readonly ok: false; readonly failure: MailConnectionFailure; readonly invalidated: boolean };

/** SELECT, then the initial window or the incremental pair. A changed `UIDVALIDITY` drops the whole account's cache. */
const syncFolder = async (
  client: ImapClient,
  folderCache: FolderCache,
  name: string,
  clearAccount: () => Promise<void>,
  isStale: () => boolean,
): Promise<FolderOutcome> => {
  let invalidated = false;
  const failed = (failure: MailConnectionFailure): FolderOutcome => ({
    ok: false,
    failure,
    invalidated,
  });
  const selectRes = await client.select(name);
  if (!selectRes.ok) return failed({ kind: 'imap', reason: selectRes.reason });
  const { uidNext, exists } = selectRes.value;
  // A server that omits UIDVALIDITY gives nothing to detect a renumbering with; 0 stands in.
  const uidValidity = selectRes.value.uidValidity ?? 0;

  let mark = await folderCache.getSync();
  if (mark !== null && mark.uidValidity !== uidValidity) {
    await clearAccount();
    mark = null;
    invalidated = true;
  }

  const kept: ImapMessageSummary[] = [];
  let fetched: readonly ImapMessageSummary[] = [];
  if (mark === null) {
    // The newest WINDOW messages by sequence number; a mailbox no bigger than the window is read whole.
    if (exists > 0) {
      const res = await client.fetchSummariesBySeq(`${Math.max(1, exists - WINDOW + 1)}:*`);
      if (!res.ok) return failed({ kind: 'imap', reason: res.reason });
      fetched = res.value;
    }
  } else {
    const known = await folderCache.listSummaries();
    if (known.length > 0) {
      const lowest = Math.min(...known.map(summary => summary.uid));
      const flagsRes = await client.fetchFlags(`${lowest}:${mark.lastUid}`);
      if (!flagsRes.ok) return failed({ kind: 'imap', reason: flagsRes.reason });
      const flagsByUid = new Map(flagsRes.value.map(({ uid, flags }) => [uid, flags]));
      const expunged: number[] = [];
      for (const summary of known) {
        const flags = flagsByUid.get(summary.uid);
        if (flags === undefined) {
          expunged.push(summary.uid);
        } else {
          kept.push({ ...summary, flags });
        }
      }
      if (expunged.length > 0) await folderCache.deleteSummaries(expunged);
    }
    if (uidNext === null || uidNext > mark.lastUid + 1) {
      const res = await client.fetchSummaries(`${mark.lastUid + 1}:*`);
      if (!res.ok) return failed({ kind: 'imap', reason: res.reason });
      // `n:*` with n past the newest uid returns the newest message again.
      const last = mark.lastUid;
      fetched = res.value.filter(summary => summary.uid > last);
    }
  }

  const all = [...kept, ...fetched];
  // Writing now would repopulate a cache another path just cleared.
  if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' });
  // A later sync keeps what `loadOlder` earned.
  const complete = mark === null ? exists <= WINDOW : mark.complete;
  await folderCache.putSummaries(all);
  await folderCache.putSync({
    name,
    uidValidity,
    // Everything below UIDNEXT has been seen, whether or not it is still here: an empty inbox, or
    // one whose newest message moved away, is caught up, not behind.
    lastUid: Math.max(
      mark?.lastUid ?? 0,
      uidNext === null ? 0 : uidNext - 1,
      ...all.map(summary => summary.uid),
    ),
    complete,
  });
  return { ok: true, summaries: all, complete, uidValidity };
};

/**
 * LIST, then each folder in turn, inbox first. Each folder is its own task, so a click queued
 * meanwhile (a body, a flag, a move) runs before the next folder rather than after the account.
 */
export const syncAccount = async (
  run: RunTask,
  cache: MailCache,
  /** Skips persisting when the account was removed or the vault locked mid-sync. */
  isStale: () => boolean = () => false,
): Promise<{
  readonly state: AccountSyncState;
  readonly byFolder: FolderSummaries;
}> => {
  const failed = (failure: MailConnectionFailure, invalidated = false) => ({
    byFolder: {} as FolderSummaries,
    state: { status: 'failed', failure, at: Date.now(), invalidated } as const,
  });

  const folders = await run({ priority: 'user', effect: 'read', retry: true, run: resolveFolders });
  if (!folders.ok) return failed(folders.error);

  let invalidated = false;
  const byFolder: FolderSummaries = {};
  const complete: Folder[] = [];
  for (const folder of FOLDERS) {
    if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' }, invalidated);
    const name = folders.value[folder];
    if (name === undefined) {
      // A folder the server does not have holds nothing older either.
      complete.push(folder);
      continue;
    }
    const synced = await run({
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async client => {
        const outcome = await syncFolder(
          client,
          cache.folder(folder),
          name,
          async () => {
            invalidated = true;
            await cache.clear();
          },
          isStale,
        );
        return outcome.ok ? { ok: true, value: outcome } : { ok: false, error: outcome.failure };
      },
    });
    if (!synced.ok) return failed(synced.error, invalidated);
    byFolder[folder] = { uidValidity: synced.value.uidValidity, summaries: synced.value.summaries };
    if (synced.value.complete) complete.push(folder);
  }

  // Summaries, not threads: grouping is one global pass only the store can run.
  return { byFolder, state: { status: 'synced', at: Date.now(), complete } };
};

/**
 * The WINDOW messages just below the oldest cached uid, measured from that message's `seq`. A uid
 * that answers nothing was expunged; nothing is loaded and nothing claimed complete.
 */
export const loadOlder = async (
  run: RunTask,
  folderCache: FolderCache,
  /** Skips persisting when the account was removed or the vault locked mid-load. */
  isStale: () => boolean = () => false,
): Promise<
  Result<{ readonly loaded: number; readonly complete: boolean }, MailConnectionFailure>
> => {
  const mark = await folderCache.getSync();
  if (mark === null) return { ok: true, value: { loaded: 0, complete: false } };
  const known = await folderCache.listSummaries();
  if (known.length === 0) return { ok: true, value: { loaded: 0, complete: false } };
  const lowest = Math.min(...known.map(summary => summary.uid));

  return run({
    priority: 'user',
    effect: 'read',
    // Idempotent: a repeated window re-reads envelopes the cache already holds by uid.
    retry: true,
    run: async client => {
      const selectRes = await client.ensureSelected(mark.name);
      if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };

      const anchorRes = await client.fetchSummaries(String(lowest));
      if (!anchorRes.ok) return { ok: false, error: { kind: 'imap', reason: anchorRes.reason } };
      const anchor = anchorRes.value[0];
      if (anchor === undefined) return { ok: true, value: { loaded: 0, complete: false } };

      // Re-read: a sync may have landed new mail meanwhile, and its `lastUid` keeps the next sync incremental.
      const markComplete = async () => {
        if (isStale()) return;
        const current = await folderCache.getSync();
        if (current === null) return;
        await folderCache.putSync({ ...current, complete: true });
      };
      if (anchor.seq <= 1) {
        await markComplete();
        return { ok: true, value: { loaded: 0, complete: true } };
      }

      const from = Math.max(1, anchor.seq - WINDOW);
      const res = await client.fetchSummariesBySeq(`${from}:${anchor.seq - 1}`);
      if (!res.ok) return { ok: false, error: { kind: 'imap', reason: res.reason } };
      // The account may have been removed, or the vault locked, while IMAP was answering.
      if (isStale()) return { ok: false, error: { kind: 'error', detail: 'load superseded' } };
      await folderCache.putSummaries(res.value);
      const complete = from === 1;
      if (complete) await markComplete();
      return { ok: true, value: { loaded: res.value.length, complete } };
    },
  });
};

/** One folder's worth of a flag write or a move, off the sync mark: one command per uid set. */
export type FlagTarget = {
  readonly folder: Folder;
  readonly mailbox: string;
  readonly uids: readonly number[];
  /** Checked against what the SELECT answers: across a renumbering the same uid names different mail. */
  readonly uidValidity: number;
};

const RENUMBERED: MailConnectionFailure = {
  kind: 'error',
  detail: 'that mailbox was renumbered; it will sync again before this can be written',
};

/** The mailbox the server just selected is not the one these uids came from. */
const renumbered = (target: FlagTarget, selected: { readonly uidValidity: number | null }) =>
  selected.uidValidity !== null && selected.uidValidity !== target.uidValidity;

const withFlag = (flags: readonly string[], flag: string, on: boolean): readonly string[] => {
  const others = flags.filter(candidate => candidate.toLowerCase() !== flag.toLowerCase());
  return on ? [...others, flag] : others;
};

/**
 * `UID STORE`, then the same flag into the device cache, so a reload shows it before any sync. In
 * the task, so it lands between the sync passes around it, never under one, and before a lock's clear.
 */
export const setFlag = async (
  run: RunTask,
  cache: MailCache,
  targets: readonly FlagTarget[],
  flag: '\\Seen' | '\\Flagged',
  on: boolean,
): Promise<Result<void, MailConnectionFailure>> =>
  run({
    priority: 'user',
    effect: 'write',
    retry: true,
    run: async client => {
      for (const target of targets) {
        const { folder, mailbox, uids } = target;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        if (renumbered(target, selectRes.value)) return { ok: false, error: RENUMBERED };
        for (const set of uidSets(uids)) {
          const storeRes = await client.storeFlags(set, on ? 'add' : 'remove', [flag]);
          if (!storeRes.ok) return { ok: false, error: { kind: 'imap', reason: storeRes.reason } };
        }
        await cache.folder(folder).updateSummaries(uids, summary => ({
          ...summary,
          flags: withFlag(summary.flags, flag, on),
        }));
      }
      return { ok: true, value: undefined };
    },
  });

/** Where a `UID MOVE` put one message; `to` is null when the server did not say (no UIDPLUS). */
export type MovedCopy = {
  readonly from: Omit<Location, 'account'>;
  readonly to: Omit<Location, 'account'> | null;
};

const destinationOf = (copy: CopyUid | null, folder: Folder, uid: number) => {
  if (copy === null) return null;
  const copied = copiedUid(copy, uid);
  return copied === null ? null : { folder, uidValidity: copy.uidValidity, uid: copied };
};

/**
 * `UID MOVE` every source mailbox's uids into `to`, answering where each went: one command per
 * mailbox, however many conversations it carries. Not retried: a half-done MOVE must not re-run.
 */
export const moveMessages = async (
  run: RunTask,
  sources: readonly FlagTarget[],
  to: 'inbox' | 'archive' | 'trash',
): Promise<Result<readonly MovedCopy[], MailConnectionFailure>> =>
  run({
    priority: 'user',
    effect: 'write',
    retry: false,
    run: async client => {
      const destination =
        to === 'inbox' ? ({ ok: true, value: 'INBOX' } as const) : await ensureMailbox(client, to);
      if (!destination.ok) return destination;
      const moved: MovedCopy[] = [];
      for (const source of sources) {
        const { mailbox, uids } = source;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        if (renumbered(source, selectRes.value)) return { ok: false, error: RENUMBERED };
        const answers: (CopyUid | null)[] = [];
        for (const set of uidSets(uids)) {
          const moveRes = await client.move(set, destination.value);
          if (!moveRes.ok) return { ok: false, error: { kind: 'imap', reason: moveRes.reason } };
          answers.push(moveRes.value);
        }
        moved.push(
          ...uids.map(uid => ({
            from: { folder: source.folder, uidValidity: source.uidValidity, uid },
            // Each answer names only the uids of its own set.
            to:
              answers
                .map(answer => destinationOf(answer, to, uid))
                .find(destination => destination !== null) ?? null,
          })),
        );
      }
      return { ok: true, value: moved };
    },
  });

/**
 * What a move did, written into the cache at once, so the next read shows it before any sync. Each
 * copy leaves its folder; it is filed where the server said it went only when that folder has
 * synced under the same `UIDVALIDITY`, and otherwise the next sync of that folder finds it. A copy
 * filed above the mark's `lastUid` is fetched again then, by uid, which replaces it.
 */
export const recordMoves = async (
  cache: MailCache,
  moved: readonly MovedCopy[],
): Promise<{ readonly isComplete: boolean }> => {
  /** Cached copies that left their folder and were filed nowhere: only a sync can say where. */
  let unfiled = 0;
  for (const [folder, copies] of Map.groupBy(moved, ({ from }) => from.folder)) {
    const source = cache.folder(folder);
    const uids = new Set(copies.map(({ from }) => from.uid));
    const summaries = (await source.listSummaries()).filter(summary => uids.has(summary.uid));
    await source.deleteSummaries([...uids]);
    const marks = new Map<Folder, FolderSync | null>();
    for (const { to } of copies) {
      if (to !== null && !marks.has(to.folder)) {
        marks.set(to.folder, await cache.folder(to.folder).getSync());
      }
    }
    const filed = summaries.flatMap(summary => {
      const to = copies.find(({ from }) => from.uid === summary.uid)?.to ?? null;
      const isFileable = to !== null && marks.get(to.folder)?.uidValidity === to.uidValidity;
      if (!isFileable) unfiled += 1;
      return isFileable ? [{ to, summary: { ...summary, uid: to.uid } }] : [];
    });
    for (const [to, landed] of Map.groupBy(filed, ({ to }) => to.folder)) {
      await cache.folder(to).putSummaries(landed.map(({ summary }) => summary));
    }
  }
  return { isComplete: unfiled === 0 };
};

/**
 * After a sync: the newest small bodies not yet cached, at background priority. Failures are
 * swallowed; each body that lands is handed to `onBody` so the list can show its excerpt.
 */
export const prefetchBodies = (
  run: RunTask,
  cache: MailCache,
  byFolder: FolderSummaries,
  ceilingBytes: number,
  perFolder: number,
  isStale: () => boolean = () => false,
  onBody: (at: Omit<Location, 'account'>, body: FetchedBody) => void = () => {},
): void => {
  for (const folder of FOLDERS) {
    const read = byFolder[folder];
    if (read === undefined) continue;
    const { summaries, uidValidity } = read;
    const folderCache = cache.folder(folder);
    void (async () => {
      const mark = await folderCache.getSync();
      if (mark === null) return;
      const cachedUids = await folderCache.listBodyUids();
      // Newest first, counting only what is eligible.
      let queued = 0;
      for (const summary of summaries.toSorted((a, b) => b.uid - a.uid)) {
        if (queued >= perFolder || isStale()) return;
        if (summary.size === null || summary.size > ceilingBytes) continue;
        if (cachedUids.has(summary.uid)) continue;
        queued += 1;
        void run({
          priority: 'background',
          effect: 'read',
          retry: true,
          run: async client => {
            if (isStale()) return { ok: true, value: undefined };
            const selected = await client.ensureSelected(mark.name);
            if (!selected.ok) {
              return { ok: false, error: { kind: 'imap', reason: selected.reason } };
            }
            const raw = await client.fetchRaw(summary.uid);
            if (!raw.ok) return { ok: false, error: { kind: 'imap', reason: raw.reason } };
            if (isStale()) return { ok: true, value: undefined };
            try {
              const body = await parseBody(raw.value);
              await folderCache.putBody(summary.uid, body);
              onBody({ folder, uidValidity, uid: summary.uid }, body);
            } catch {
              // Best effort.
            }
            return { ok: true, value: undefined };
          },
        });
      }
    })();
  }
};
