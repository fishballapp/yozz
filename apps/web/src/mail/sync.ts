import type { ImapClient, ImapMessageSummary } from '@yozz.app/imap';
import type { InboundAddress } from '../lib/addresses';
import { FOLDERS, type Folder } from '../lib/thread';
import { parseBody } from './bodies';
import type { FolderCache, MailCache } from './cache';
import { connectImap, type MailConnectionFailure, type Result } from './connection';
import type { LiveClient, LiveTask } from './live';
import { ensureMailbox, resolveFolders } from './mailboxes';
import type { FolderSummaries } from './summaries';

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

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

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
  // Writing now would repopulate a cache another path just cleared.
  if (isStale()) return failed({ kind: 'error', detail: 'sync superseded' });
  // A later sync keeps what `loadOlder` earned.
  const complete = mark === null ? exists <= WINDOW : mark.complete;
  await folderCache.putSummaries(all);
  await folderCache.putSync({
    name,
    uidValidity,
    lastUid: Math.max(mark?.lastUid ?? 0, ...all.map(summary => summary.uid)),
    complete,
  });
  return { ok: true, summaries: all, complete, uidValidity };
};

/** LIST, then each folder in turn, inbox first. */
export const syncAccount = async (
  run: Run,
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
        byFolder[folder] = { uidValidity: outcome.uidValidity, summaries: outcome.summaries };
        if (outcome.complete) complete.push(folder);
      }
      // Summaries, not threads: grouping is one global pass only the store can run.
      return { ok: true, value: { byFolder, complete } };
    },
  });

  if (!result.ok) return failed(result.error, invalidated);
  return {
    byFolder: result.value.byFolder,
    state: {
      status: 'synced',
      at: Date.now(),
      complete: result.value.complete,
    },
  };
};

/**
 * The WINDOW messages just below the oldest cached uid, measured from that message's `seq`. A uid
 * that answers nothing was expunged; nothing is loaded and nothing claimed complete.
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

/** The list before the first sync of this unlock lands. */
export const cachedSummaries = async (cache: MailCache): Promise<FolderSummaries> => {
  const byFolder: FolderSummaries = {};
  for (const folder of FOLDERS) {
    const folderCache = cache.folder(folder);
    const mark = await folderCache.getSync();
    byFolder[folder] = {
      // No sync mark means nothing read yet; UIDVALIDITY stands in as 0.
      uidValidity: mark?.uidValidity ?? 0,
      summaries: await folderCache.listSummaries(),
    };
  }
  return byFolder;
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

/** One folder's worth of a flag write, off the sync mark. */
export type FlagTarget = {
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
      for (const target of targets) {
        const { mailbox, uids } = target;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        if (renumbered(target, selectRes.value)) return { ok: false, error: RENUMBERED };
        const storeRes = await client.storeFlags(uids.join(','), on ? 'add' : 'remove', [flag]);
        if (!storeRes.ok) return { ok: false, error: { kind: 'imap', reason: storeRes.reason } };
      }
      return { ok: true, value: undefined };
    },
  });

/** `UID MOVE` every source mailbox's uids into `to`. Not retried: a half-done MOVE must not re-run. */
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
      for (const source of sources) {
        const { mailbox, uids } = source;
        if (uids.length === 0) continue;
        const selectRes = await client.ensureSelected(mailbox);
        if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
        if (renumbered(source, selectRes.value)) return { ok: false, error: RENUMBERED };
        const moveRes = await client.move(uids.join(','), destination.value);
        if (!moveRes.ok) return { ok: false, error: { kind: 'imap', reason: moveRes.reason } };
      }
      return { ok: true, value: undefined };
    },
  });

/** After a sync: the newest small bodies not yet cached, at background priority. Failures are swallowed. */
export const prefetchBodies = (
  run: Run,
  cache: MailCache,
  byFolder: FolderSummaries,
  ceilingBytes: number,
  perFolder: number,
  isStale: () => boolean = () => false,
): void => {
  for (const folder of FOLDERS) {
    const read = byFolder[folder];
    if (read === undefined) continue;
    const { summaries } = read;
    const folderCache = cache.folder(folder);
    void (async () => {
      const mark = await folderCache.getSync();
      if (mark === null) return;
      // Newest first, counting only what is eligible.
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
              // Best effort.
            }
            return { ok: true, value: undefined };
          },
        });
      }
    })();
  }
};
