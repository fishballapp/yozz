import {
  type CopyUid,
  copiedUid,
  type ImapClient,
  type ImapFailure,
  type ImapMessageSummary,
  type ImapRawMessage,
  type ImapResult,
  uidSets,
} from '@yozz.app/imap';
import { ensureFolderName, resolveFolders } from '../addresses/folder-names.ts';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import { type FetchedBody, parseBody } from './bodies.ts';
import type { FolderCache, FolderSync, MailCache } from './cache.ts';
import type { TxtLookup } from './dkim.ts';
import type { FolderRead, FolderSummaries } from './summaries.ts';
import { FOLDERS, type Folder, type Location } from './thread.ts';

export type MailboxSyncState =
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
  | (FolderRead & {
      readonly ok: true;
      /** The cache reaches the folder's oldest message. */
      readonly complete: boolean;
      /** Cached mail the server no longer has here: moved or deleted, perhaps by another client. */
      readonly hasLostMail: boolean;
    })
  | { readonly ok: false; readonly failure: MailConnectionFailure; readonly invalidated: boolean };

/**
 * The mail above the mark, or the newest window when there is no mark or the gap may be wider
 * than one. `startsOver` when that window does not reach back to the mark: the cache below it would
 * be cut off from it by mail nobody read, so the folder is read as a first sync reads it.
 */
const readNewMail = async (
  client: ImapClient,
  mark: FolderSync | null,
  { exists, uidNext }: { readonly exists: number; readonly uidNext: number | null },
): Promise<
  ImapResult<{ readonly fetched: readonly ImapMessageSummary[]; readonly startsOver: boolean }>
> => {
  const isWide = mark === null || (uidNext !== null && uidNext - 1 - mark.lastUid > WINDOW);
  if (!isWide) {
    if (uidNext !== null && uidNext <= mark.lastUid + 1) {
      return { ok: true, value: { fetched: [], startsOver: false } };
    }
    const res = await client.fetchSummaries(`${mark.lastUid + 1}:*`);
    if (!res.ok) return res;
    // `n:*` with n past the newest uid returns the newest message again.
    const fetched = res.value.filter(summary => summary.uid > mark.lastUid);
    return { ok: true, value: { fetched, startsOver: false } };
  }
  if (exists === 0) return { ok: true, value: { fetched: [], startsOver: false } };
  // A folder no bigger than the window is read whole.
  const from = Math.max(1, exists - WINDOW + 1);
  const res = await client.fetchSummariesBySeq(`${from}:*`);
  if (!res.ok) return res;
  if (mark === null) return { ok: true, value: { fetched: res.value, startsOver: false } };
  // Every uid above the window's oldest message is in it, so one at or below the mark means the
  // window holds the whole gap.
  const isGapInWindow = from === 1 || res.value.some(summary => summary.uid <= mark.lastUid);
  if (!isGapInWindow) return { ok: true, value: { fetched: res.value, startsOver: true } };
  return {
    ok: true,
    value: { fetched: res.value.filter(summary => summary.uid > mark.lastUid), startsOver: false },
  };
};

/** The cached summaries the server still has, with its flags; the rest were expunged or moved away. */
const refreshCached = async (
  client: ImapClient,
  cached: readonly ImapMessageSummary[],
  mark: FolderSync,
): Promise<ImapResult<readonly ImapMessageSummary[]>> => {
  const range = `${Math.min(...cached.map(summary => summary.uid))}:${mark.lastUid}`;
  const flagsRes = await client.fetchFlags(range);
  if (!flagsRes.ok) return flagsRes;
  const flagsByUid = new Map(flagsRes.value.map(({ uid, flags }) => [uid, flags]));
  // Once, for what was cached before summaries carried names; a new uid arrives with its own.
  const namesRes =
    mark.hasAttachmentNames === true
      ? ({ ok: true, value: [] } as const)
      : await client.fetchAttachmentNames(range);
  if (!namesRes.ok) return namesRes;
  const namesByUid = new Map(namesRes.value.map(n => [n.uid, n.attachmentNames]));
  return {
    ok: true,
    value: cached.flatMap(summary => {
      const flags = flagsByUid.get(summary.uid);
      if (flags === undefined) return [];
      return [
        {
          ...summary,
          flags,
          attachmentNames: namesByUid.get(summary.uid) ?? summary.attachmentNames,
        },
      ];
    }),
  };
};

/**
 * SELECT, then the new mail, then the flags of what was cached. A changed `UIDVALIDITY` drops the
 * whole mailbox's cache. `onRead` hears the folder once its new mail is in, when flags are still to
 * come, and again once it is written.
 */
const syncFolder = async (
  client: ImapClient,
  folderCache: FolderCache,
  name: string,
  clearMailbox: () => Promise<void>,
  isStale: () => boolean,
  onRead: (read: FolderRead) => void,
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
    await clearMailbox();
    mark = null;
    invalidated = true;
  }
  const known = mark === null ? [] : await folderCache.listSummaries();

  const newMail = await readNewMail(client, mark, { exists, uidNext });
  if (!newMail.ok) return failed({ kind: 'imap', reason: newMail.reason });
  const { fetched, startsOver } = newMail.value;
  // A copy `recordMoves` filed above the mark is new mail to this folder, read again with the rest
  // of it, and outside the range whose flags are refreshed.
  const cached =
    mark === null || startsOver ? [] : known.filter(summary => summary.uid <= mark.lastUid);

  // New mail is what a stale device is waiting for; the flags of what it already shows can follow.
  if (cached.length > 0 && fetched.length > 0 && !isStale()) {
    onRead({ uidValidity, summaries: [...cached, ...fetched] });
  }
  const kept =
    mark === null || cached.length === 0
      ? ({ ok: true, value: [] } as const)
      : await refreshCached(client, cached, mark);
  if (!kept.ok) return failed({ kind: 'imap', reason: kept.reason });

  const all = [...kept.value, ...fetched];
  // Writing now would repopulate a cache another path just cleared.
  if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' });
  const keptUids = new Set(kept.value.map(summary => summary.uid));
  const dropped = known.filter(summary => !keptUids.has(summary.uid));
  // Before the put: a copy `recordMoves` filed above the mark is read again here, by uid.
  if (dropped.length > 0) await folderCache.deleteSummaries(dropped.map(summary => summary.uid));
  // A later sync keeps what `loadOlder` earned; a folder with no mail has nothing older to offer.
  const complete = mark === null || startsOver ? exists <= WINDOW : mark.complete || exists === 0;
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
    hasAttachmentNames: true,
  });
  onRead({ uidValidity, summaries: all });
  const hasLostMail = cached.some(summary => !keptUids.has(summary.uid));
  return { ok: true, summaries: all, complete, uidValidity, hasLostMail };
};

/** What a sync reads: every folder, or the inbox alone, which is where new mail arrives. */
export type SyncScope = 'all' | 'inbox';

/**
 * The inbox, then LIST, then each other folder in turn. Each folder is its own task, so a click
 * queued meanwhile (a body, a flag, a move) runs before the next folder rather than after the
 * mailbox, and `onFolder` hears each as it lands, so new mail shows before the rest has caught up.
 * An `inbox` sync stops after the inbox, unless INBOX was renumbered, which cleared every folder's
 * cache, or mail it held has gone, most likely to a folder another client filed it in: then the rest
 * is read too. `scope` says which it was.
 */
export const syncMailbox = async (
  run: RunTask,
  cache: MailCache,
  /** Skips persisting when the mailbox was removed or the vault locked mid-sync. */
  isStale: () => boolean = () => false,
  /** A folder's summaries as soon as they are read, its new mail first; see `syncFolder`. */
  onFolder: (folder: Folder, read: FolderRead) => void = () => {},
  wanted: SyncScope = 'all',
): Promise<{
  readonly state: MailboxSyncState;
  readonly byFolder: FolderSummaries;
  readonly scope: SyncScope;
}> => {
  const failed = (failure: MailConnectionFailure, invalidated = false) => ({
    byFolder: {} as FolderSummaries,
    state: { status: 'failed', failure, at: Date.now(), invalidated } as const,
    scope: wanted,
  });

  let invalidated = false;
  const byFolder: FolderSummaries = {};
  const complete: Folder[] = [];
  const syncOne = async (folder: Folder, name: string) => {
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
          read => onFolder(folder, read),
        );
        return outcome.ok ? { ok: true, value: outcome } : { ok: false, error: outcome.failure };
      },
    });
    if (!synced.ok) return synced;
    byFolder[folder] = { uidValidity: synced.value.uidValidity, summaries: synced.value.summaries };
    if (synced.value.complete) complete.push(folder);
    return synced;
  };

  // The inbox is always `INBOX`, so it needs no LIST and is the first folder on screen.
  if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' });
  const inbox = await syncOne('inbox', 'INBOX');
  if (!inbox.ok) return failed(inbox.error, invalidated);
  if (wanted === 'inbox' && !invalidated && !inbox.value.hasLostMail) {
    return { byFolder, state: { status: 'synced', at: Date.now(), complete }, scope: 'inbox' };
  }

  const folders = await run({ priority: 'user', effect: 'read', retry: true, run: resolveFolders });
  if (!folders.ok) return failed(folders.error, invalidated);
  for (const folder of FOLDERS.filter(folder => folder !== 'inbox')) {
    if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' }, invalidated);
    const name = folders.value[folder];
    if (name === undefined) {
      // A folder the server does not have holds nothing older either.
      complete.push(folder);
      continue;
    }
    const synced = await syncOne(folder, name);
    if (!synced.ok) return failed(synced.error, invalidated);
  }

  // Summaries, not threads: grouping is one global pass only the store can run.
  return { byFolder, state: { status: 'synced', at: Date.now(), complete }, scope: 'all' };
};

/**
 * The WINDOW messages just below the oldest cached uid that still answers, measured from that
 * message's `seq`. A cached row whose message was moved or expunged since the last sync stays until
 * a sync drops it, so the anchor is the lowest one the server still has. With none, as when triage
 * emptied the window, the folder's own count says where the newest page starts.
 */
export const loadOlder = async (
  run: RunTask,
  folderCache: FolderCache,
  /** Skips persisting when the mailbox was removed or the vault locked mid-load. */
  isStale: () => boolean = () => false,
): Promise<
  Result<{ readonly loaded: number; readonly complete: boolean }, MailConnectionFailure>
> =>
  run({
    priority: 'user',
    effect: 'read',
    // Idempotent: a repeated window re-reads envelopes the cache already holds by uid, and the
    // cache is read again inside, so a retry sees what the attempt before it wrote.
    retry: true,
    run: async client => {
      // Read here, not before queueing: a sync that ran first may have changed both.
      const mark = await folderCache.getSync();
      if (mark === null) return { ok: true, value: { loaded: 0, complete: false } };
      const known = await folderCache.listSummaries();
      const imapFailure = (reason: ImapFailure) =>
        ({ ok: false, error: { kind: 'imap', reason } }) as const;
      const superseded = {
        ok: false,
        error: { kind: 'error', detail: 'load superseded' },
      } as const;

      // Re-read: a sync may have landed new mail meanwhile, and its `lastUid` keeps the next sync incremental.
      const markComplete = async () => {
        if (isStale()) return;
        const current = await folderCache.getSync();
        if (current === null) return;
        await folderCache.putSync({ ...current, complete: true });
      };

      /** Nothing to measure from, so the folder's own count does it. */
      const readNewest = async () => {
        // Fresh, not `ensureSelected`'s: a stale EXISTS would start the page past the newest mail.
        const selectRes = await client.select(mark.name);
        if (!selectRes.ok) return imapFailure(selectRes.reason);
        if ((selectRes.value.uidValidity ?? 0) !== mark.uidValidity) {
          return { ok: false, error: RENUMBERED } as const;
        }
        const { exists } = selectRes.value;
        if (exists === 0) {
          await markComplete();
          return { ok: true, value: { loaded: 0, complete: true } } as const;
        }
        const from = Math.max(1, exists - WINDOW + 1);
        const res = await client.fetchSummariesBySeq(`${from}:*`);
        if (!res.ok) return imapFailure(res.reason);
        if (isStale()) return superseded;
        // Mail past `lastUid` is the next sync's to read; the cache stays one window up to it.
        const read = res.value.filter(summary => summary.uid <= mark.lastUid);
        await folderCache.putSummaries(read);
        const complete = from === 1;
        if (complete) await markComplete();
        return { ok: true, value: { loaded: read.length, complete } } as const;
      };

      if (known.length === 0) return readNewest();

      const selectRes = await client.ensureSelected(mark.name);
      if (!selectRes.ok) return imapFailure(selectRes.reason);

      const lowest = Math.min(...known.map(summary => summary.uid));
      const lowestRes = await client.fetchSummaries(String(lowest));
      if (!lowestRes.ok) return imapFailure(lowestRes.reason);
      let anchor = lowestRes.value[0];
      if (anchor === undefined) {
        // Ascending sets, so the first to answer holds the lowest uid still here.
        let alive: number | null = null;
        for (const set of uidSets(known.map(summary => summary.uid))) {
          const flagsRes = await client.fetchFlags(set);
          if (!flagsRes.ok) return imapFailure(flagsRes.reason);
          if (flagsRes.value.length === 0) continue;
          alive = Math.min(...flagsRes.value.map(({ uid }) => uid));
          break;
        }
        if (alive === null) return readNewest();
        const aliveRes = await client.fetchSummaries(String(alive));
        if (!aliveRes.ok) return imapFailure(aliveRes.reason);
        anchor = aliveRes.value[0];
        if (anchor === undefined) return { ok: true, value: { loaded: 0, complete: false } };
      }

      if (anchor.seq <= 1) {
        await markComplete();
        return { ok: true, value: { loaded: 0, complete: true } };
      }

      const from = Math.max(1, anchor.seq - WINDOW);
      const res = await client.fetchSummariesBySeq(`${from}:${anchor.seq - 1}`);
      if (!res.ok) return imapFailure(res.reason);
      // The mailbox may have been removed, or the vault locked, while IMAP was answering.
      if (isStale()) return superseded;
      await folderCache.putSummaries(res.value);
      const complete = from === 1;
      if (complete) await markComplete();
      return { ok: true, value: { loaded: res.value.length, complete } };
    },
  });

/** One folder's worth of a flag write or a move, off the sync mark: one command per uid set. */
export type FlagTarget = {
  readonly folder: Folder;
  readonly folderName: string;
  readonly uids: readonly number[];
  /** Checked against what the SELECT answers: across a renumbering the same uid names different mail. */
  readonly uidValidity: number;
};

const RENUMBERED: MailConnectionFailure = {
  kind: 'error',
  detail: 'that mailbox was renumbered; it will sync again before this can be written',
};

/** The folder the server just selected is not the one these uids came from. */
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
        const { folder, folderName, uids } = target;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(folderName);
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
  readonly from: Omit<Location, 'mailbox'>;
  readonly to: Omit<Location, 'mailbox'> | null;
};

const destinationOf = (copy: CopyUid | null, folder: Folder, uid: number) => {
  if (copy === null) return null;
  const copied = copiedUid(copy, uid);
  return copied === null ? null : { folder, uidValidity: copy.uidValidity, uid: copied };
};

/**
 * `UID MOVE` every source folder's uids into `to`, answering where each went: one command per
 * folder, however many conversations it carries. Not retried: a half-done MOVE must not re-run.
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
        to === 'inbox'
          ? ({ ok: true, value: 'INBOX' } as const)
          : await ensureFolderName(client, to);
      if (!destination.ok) return destination;
      const moved: MovedCopy[] = [];
      for (const source of sources) {
        const { folderName, uids } = source;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(folderName);
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

/** What a prefetch reads, the inbox first: Trash is seldom read again, and Drafts are not threaded. */
const PREFETCH_FOLDERS = ['inbox', 'sent', 'archive'] as const satisfies readonly Folder[];

/**
 * About this much raw mail per command. A command costs seconds on a slow server whatever it
 * carries, and a click waits behind at most one of these.
 */
const PREFETCH_BATCH_BYTES = 1024 * 1024;

/** `items` in order, cut wherever the next would take a chunk's weight past `max`; one heavier alone is a chunk. */
const chunkByWeight = <T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  max: number,
): readonly (readonly T[])[] => {
  const chunks: { items: T[]; weight: number }[] = [];
  for (const item of items) {
    const weight = weightOf(item);
    const last = chunks.at(-1);
    if (last !== undefined && last.weight + weight <= max) {
      last.items.push(item);
      last.weight += weight;
      continue;
    }
    chunks.push({ items: [item], weight });
  }
  return chunks.map(({ items }) => items);
};

/** A body a prefetch stored, where it sits. */
export type PrefetchedBody = { readonly at: Omit<Location, 'mailbox'>; readonly body: FetchedBody };

/**
 * After a sync: the newest small bodies not yet cached, at background priority, several to a
 * `UID FETCH` (`PREFETCH_BATCH_BYTES`), the inbox's queued first. Each batch checks the cache again
 * when its turn comes, so a second sync's prefetch does not fetch what the first's has stored.
 * Failures are swallowed; each batch that lands is handed to `onBodies` at once, so the list shows
 * its excerpts with one update.
 */
export const prefetchBodies = async (
  run: RunTask,
  cache: MailCache,
  byFolder: FolderSummaries,
  ceilingBytes: number,
  perFolder: number,
  lookupTxt: TxtLookup,
  isStale: () => boolean = () => false,
  onBodies: (bodies: readonly PrefetchedBody[]) => void = () => {},
): Promise<void> => {
  const batches: Promise<void>[] = [];
  for (const folder of PREFETCH_FOLDERS) {
    const read = byFolder[folder];
    if (read === undefined || isStale()) continue;
    const { summaries, uidValidity } = read;
    const folderCache = cache.folder(folder);
    // Awaited folder by folder, so every inbox batch is queued before the next folder's.
    const mark = await folderCache.getSync();
    if (mark === null || mark.uidValidity !== uidValidity) continue;
    const cachedUids = await folderCache.listBodyUids();
    // Newest first, counting only what is eligible.
    const wanted = summaries
      .filter(({ uid, size }) => size !== null && size <= ceilingBytes && !cachedUids.has(uid))
      .toSorted((a, b) => b.uid - a.uid)
      .slice(0, perFolder);
    for (const batch of chunkByWeight(wanted, ({ size }) => size ?? 0, PREFETCH_BATCH_BYTES)) {
      batches.push(
        (async () => {
          const raw = await run<readonly ImapRawMessage[]>({
            priority: 'background',
            effect: 'read',
            retry: true,
            run: async client => {
              const none = { ok: true, value: [] } as const;
              if (isStale()) return none;
              const storedNow = await folderCache.listBodyUids();
              const uids = batch.map(({ uid }) => uid).filter(uid => !storedNow.has(uid));
              if (uids.length === 0) return none;
              const selected = await client.ensureSelected(mark.name);
              if (!selected.ok) {
                return { ok: false, error: { kind: 'imap', reason: selected.reason } };
              }
              // Renumbered since the sync: these uids may name other mail now.
              if ((selected.value.uidValidity ?? 0) !== uidValidity) return none;
              const fetched: ImapRawMessage[] = [];
              for (const set of uidSets(uids)) {
                const res = await client.fetchRawMessages(set);
                if (!res.ok) return { ok: false, error: { kind: 'imap', reason: res.reason } };
                fetched.push(...res.value);
              }
              return { ok: true, value: fetched };
            },
          });
          // After the task: the connection is not held while DNS answers.
          if (!raw.ok || isStale()) return;
          const landed: PrefetchedBody[] = [];
          for (const { uid, bytes } of raw.value) {
            try {
              const body = await parseBody(bytes, lookupTxt);
              await folderCache.putBody(uid, body);
              landed.push({ at: { folder, uidValidity, uid }, body });
            } catch {
              // Best effort.
            }
          }
          if (landed.length > 0 && !isStale()) onBodies(landed);
        })(),
      );
    }
  }
  await Promise.all(batches);
};
