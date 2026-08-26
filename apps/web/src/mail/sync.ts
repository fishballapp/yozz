import type { ImapClient, ImapMessageSummary } from '@yozz.app/imap';
import type { InboundAddress } from '../lib/addresses';
import { FOLDERS, type Folder } from '../lib/thread';
import type { ThreadState } from '../state/mail';
import { parseBody } from './bodies';
import type { FolderCache, MailCache } from './cache';
import { connectImap, type MailConnectionFailure, type Result } from './connection';
import type { LiveClient, LiveTask } from './live';
import { ensureMailbox, resolveFolders } from './mailboxes';
import { type FolderSummaries, threadsFromSummaries } from './summaries';

export type AccountSyncState =
  | { readonly status: 'idle' }
  | { readonly status: 'syncing' }
  | {
      readonly status: 'synced';
      readonly at: number;
      readonly count: number;
      /** The folders whose oldest message is cached: there is nothing left to page back to. */
      readonly complete: readonly Folder[];
    }
  | {
      readonly status: 'failed';
      readonly failure: MailConnectionFailure;
      readonly at: number;
      /**
       * The account's cache was dropped (a `UIDVALIDITY` change) before this sync then failed, so
       * the in-memory threads are stale — their uids are invalid, and a reused one would open the
       * wrong body. The caller empties the account rather than leaving them on screen.
       */
      readonly invalidated?: boolean;
    };

/**
 * How many messages a window is, whether it is the FIRST sync of a folder or a later page back.
 * Counted in message SEQUENCE numbers, which are dense — uids are not, so a 200-wide uid range
 * holds 200 messages only in a mailbox nothing was ever deleted from. Syncs between the two are
 * incremental: new uids above the last seen one, plus a flags-only refresh of what is cached.
 */
const WINDOW = 200;

type FolderOutcome =
  | {
      readonly ok: true;
      readonly summaries: readonly ImapMessageSummary[];
      /** The folder's oldest message is cached — this first sync reached the whole of it. */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly failure: MailConnectionFailure; readonly invalidated: boolean };

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/**
 * One folder on an open connection: SELECT, then either the initial window or the incremental
 * pair (flags of the known range, summaries above it). A changed `UIDVALIDITY` drops the whole
 * account's cache first — one folder's renumbering is rare enough that re-reading both is the
 * simpler truth. What comes back is every summary the folder's cache now holds.
 */
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
  // A server that omits UIDVALIDITY gives nothing to detect a renumbering with; 0 stands in,
  // and every sync then trusts the cache.
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
    // The newest WINDOW messages of the folder, by sequence number: an empty mailbox has none,
    // and a mailbox no bigger than the window is read whole.
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
        if (flags === undefined) expunged.push(summary.uid);
        else kept.push({ ...summary, flags });
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
  // The account may have been removed, or the vault locked, while IMAP was answering. Writing
  // now would repopulate a cache another path just cleared.
  if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' });
  // A first sync reaches the folder's start when the whole of it fitted in one window; a later
  // one changes nothing about how far back the cache goes, so it keeps what `loadOlder` earned.
  const complete = mark === null ? exists <= WINDOW : mark.complete;
  await folderCache.putSummaries(all);
  await folderCache.putSync({
    name,
    uidValidity,
    lastUid: Math.max(mark?.lastUid ?? 0, ...all.map(summary => summary.uid)),
    complete,
  });
  return { ok: true, summaries: all, complete };
};

/**
 * One live-connection task per account: LIST to find the folders, then each folder in turn,
 * inbox first. What comes back is every summary the cache now holds, threaded across the four
 * folders — which is how your own replies sit in the conversation they answer.
 */
export const syncAccount = async (
  run: Run,
  cache: MailCache,
  record: InboundAddress,
  /** Skips persisting when the account was removed or the vault locked mid-sync. */
  isStale: () => boolean = () => false,
): Promise<{
  readonly threads: readonly ThreadState[];
  readonly state: AccountSyncState;
  readonly byFolder: FolderSummaries;
}> => {
  const failed = (failure: MailConnectionFailure, invalidated = false) => ({
    threads: [] as readonly ThreadState[],
    byFolder: {} as FolderSummaries,
    state: { status: 'failed', failure, at: Date.now(), invalidated } as const,
  });

  let invalidated = false;
  const result = await run({
    priority: 'user',
    retry: true,
    run: async (client: LiveClient) => {
      const folders = await resolveFolders(client);
      if (!folders.ok) return folders;
      const byFolder: FolderSummaries = {};
      const complete: Folder[] = [];
      for (const folder of FOLDERS) {
        const name = folders.value[folder];
        if (name === undefined) {
          // A folder the server does not have holds nothing older either.
          complete.push(folder);
          continue;
        }
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
        if (!outcome.ok) return { ok: false, error: outcome.failure };
        byFolder[folder] = outcome.summaries;
        if (outcome.complete) complete.push(folder);
      }
      return {
        ok: true,
        value: { threads: threadsFromSummaries(byFolder, record.address), byFolder, complete },
      };
    },
  });

  if (!result.ok) return failed(result.error, invalidated);
  return {
    threads: result.value.threads,
    byFolder: result.value.byFolder,
    state: {
      status: 'synced',
      at: Date.now(),
      count: result.value.threads.length,
      complete: result.value.complete,
    },
  };
};

/**
 * One page further back in a folder, on the live connection: the WINDOW messages that sit just
 * below the oldest one already cached.
 *
 * The lowest cached uid is turned into a sequence number by fetching that one message — its `seq`
 * is what the window is measured from, since sequence numbers are dense and uids are not. A uid
 * that answers nothing was expunged since the last sync, which the next plain sync will notice;
 * nothing is loaded and nothing is claimed complete, so the control stays and works after it.
 */
export const loadOlder = async (
  run: Run,
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
    // Idempotent: a repeated window re-reads envelopes the cache already holds by uid.
    retry: true,
    run: async client => {
      const selectRes = await client.ensureSelected(mark.name);
      if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };

      const anchorRes = await client.fetchSummaries(String(lowest));
      if (!anchorRes.ok) return { ok: false, error: { kind: 'imap', reason: anchorRes.reason } };
      const anchor = anchorRes.value[0];
      if (anchor === undefined) return { ok: true, value: { loaded: 0, complete: false } };

      // Re-read rather than write back the mark this started from: a sync may have landed new
      // mail meanwhile, and its `lastUid` is what keeps the next sync incremental.
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

/** What the cache already holds, threaded — the list before the first sync of this unlock lands. */
export const cachedThreads = async (
  cache: MailCache,
  accountAddress: string,
): Promise<readonly ThreadState[]> => {
  const byFolder: FolderSummaries = {};
  for (const folder of FOLDERS) byFolder[folder] = await cache.folder(folder).listSummaries();
  return threadsFromSummaries(byFolder, accountAddress);
};

/** Open, authenticate, close: what Connect runs before it stores a password. */
export const testImap = async (
  imap: InboundAddress['imap'],
): Promise<Result<void, MailConnectionFailure>> => {
  const connRes = await connectImap(imap);
  if (!connRes.ok) return { ok: false, error: connRes.error };
  await connRes.value.close();
  return { ok: true, value: undefined };
};

/** One folder's worth of a flag write: the uids and the mailbox `SELECT` names, off the sync mark. */
export type FlagTarget = { readonly mailbox: string; readonly uids: readonly number[] };

export const setFlag = async (
  run: Run,
  targets: readonly FlagTarget[],
  flag: '\\Seen' | '\\Flagged',
  on: boolean,
): Promise<Result<void, MailConnectionFailure>> =>
  run({
    priority: 'user',
    retry: true,
    run: async client => {
      for (const { mailbox, uids } of targets) {
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        const storeRes = await client.storeFlags(uids.join(','), on ? 'add' : 'remove', [flag]);
        if (!storeRes.ok) return { ok: false, error: { kind: 'imap', reason: storeRes.reason } };
      }
      return { ok: true, value: undefined };
    },
  });

/**
 * Move a thread: `UID MOVE` every source mailbox's uids into `to` — `INBOX`, else the mailbox
 * `ensureMailbox` resolves or creates. One task, so a thread spread over folders arrives whole.
 * Not retried — a MOVE that half-happened must not re-run on a fresh connection.
 */
export const moveThread = async (
  run: Run,
  sources: readonly FlagTarget[],
  to: 'inbox' | 'archive' | 'trash',
): Promise<Result<void, MailConnectionFailure>> =>
  run({
    priority: 'user',
    retry: false,
    run: async client => {
      const destination =
        to === 'inbox' ? ({ ok: true, value: 'INBOX' } as const) : await ensureMailbox(client, to);
      if (!destination.ok) return destination;
      for (const { mailbox, uids } of sources) {
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        const moveRes = await client.move(uids.join(','), destination.value);
        if (!moveRes.ok) return { ok: false, error: { kind: 'imap', reason: moveRes.reason } };
      }
      return { ok: true, value: undefined };
    },
  });

/**
 * After a sync: fetch the newest small bodies that are not yet cached, at background priority.
 * Failures are swallowed — a body that did not prefetch is fetched on open.
 */
export const prefetchBodies = (
  run: Run,
  cache: MailCache,
  byFolder: FolderSummaries,
  ceilingBytes: number,
  perFolder: number,
  isStale: () => boolean = () => false,
): void => {
  for (const folder of FOLDERS) {
    const summaries = byFolder[folder];
    if (summaries === undefined) continue;
    const folderCache = cache.folder(folder);
    void (async () => {
      const mark = await folderCache.getSync();
      if (mark === null) return;
      // Newest first, counting only what is actually eligible: a run of already-cached
      // messages at the top must not use up the budget.
      let queued = 0;
      for (const summary of summaries.toSorted((a, b) => b.uid - a.uid)) {
        if (queued >= perFolder || isStale()) return;
        if (summary.size === null || summary.size > ceilingBytes) continue;
        if ((await folderCache.getBody(summary.uid)) !== null) continue;
        queued += 1;
        void run({
          priority: 'background',
          retry: true,
          run: async client => {
            if (isStale()) return { ok: true, value: undefined };
            const selected = await client.ensureSelected(mark.name);
            if (!selected.ok)
              return { ok: false, error: { kind: 'imap', reason: selected.reason } };
            const raw = await client.fetchRaw(summary.uid);
            if (!raw.ok) return { ok: false, error: { kind: 'imap', reason: raw.reason } };
            if (isStale()) return { ok: true, value: undefined };
            try {
              await folderCache.putBody(summary.uid, await parseBody(raw.value));
            } catch {
              // Prefetch is best-effort.
            }
            return { ok: true, value: undefined };
          },
        });
      }
    })();
  }
};
