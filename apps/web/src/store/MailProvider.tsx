import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  isInbound,
  parseAddressRecord,
} from '../addresses/record';
import { isJudgeAddress } from '../dev/judge/domain';
import type { MailConnectionFailure, Result } from '../relay/connection';
import { describeMailFailure } from '../relay/describe-failure';
import type { LiveManager, LiveState, LiveTask } from '../relay/live';
import {
  type BodyEntry,
  type BodyOutcome,
  MAX_CACHED_BODY_BYTES,
  type Previews,
  previewKey,
  withBodies,
  withoutAccountPreviews,
} from '../threads/body-state';
import {
  applyOps,
  assertSameUidValidity,
  MOVE_SOURCES,
  type MoveTarget,
  type PendingChange,
  type PendingOp,
  retireOps,
} from '../threads/reconcile';
import { type AccountSummaries, threadsFromAccounts, withDrafts } from '../threads/summaries';
import type { AccountSyncState, FlagTarget } from '../threads/sync';
import type { ThreadState } from '../threads/thread';
import { type Folder, isArchived, type Location as MailLocation } from '../threads/thread';
import { accountsShown, folderPaged, type MailboxId } from '../threads/views';
import { isDemo } from '../ui/chrome';
import { vaultErrorMessage } from '../vault/screen-policy';
import { useVault } from '../vault/session';
import { type Composer, useComposer } from './use-composer';

/**
 * The app's mutable mail state. Threads are held in memory only: a lock drops them. The contexts'
 * IO modules are reached through dynamic imports so the TLS stack and root bundle stay out of the
 * entry chunk.
 */

type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

type MailContextValue = Composer & {
  accounts: readonly InboundAddress[];
  identities: readonly AddressRecord[];
  /** Every address you own, inbound or send-only. */
  ownedAddresses: readonly string[];
  threads: readonly ThreadState[];
  isDemo: boolean;
  recordsError: string | null;
  /** The last refused read/star write or body fetch; cleared by the next one that works. */
  flagError: string | null;
  syncStates: Readonly<Record<string, AccountSyncState>>;
  liveStates: Readonly<Record<string, LiveState>>;
  sync: (address?: string) => Promise<void>;
  /** Pages one window further back, on every account this mailbox shows. Coalesced per account and folder. */
  loadOlder: (mailbox: MailboxId) => Promise<void>;
  /** Whether that mailbox's page is in flight. */
  isLoadingOlder: (mailbox: MailboxId) => boolean;
  /** Flag and move answer `false` (and set `flagError`) while a move of the same thread is pending. */
  markRead: (threadId: string) => boolean;
  /** Puts the whole thread back to unread; the reader closes with it. */
  markUnread: (threadId: string) => boolean;
  toggleStar: (threadId: string) => boolean;
  /** Fetches a body, joining a fetch in flight, and resolves with the outcome itself. */
  loadBody: (threadId: string, messageId: string) => Promise<BodyOutcome>;
  toggleArchive: (threadId: string) => boolean;
  /** Moves the whole conversation to Trash, own sent copies included. */
  trashThread: (threadId: string) => boolean;
  /** Brings a thread back to the inbox from Trash or Archive. */
  restoreThread: (threadId: string) => boolean;
  /** HACKATHON ONLY (see `judge/`): resets a demo mailbox, then re-syncs. Delete with `judge/` after 2026-09-03. */
  resetDemoInbox: () => Promise<string>;
  putAddress: (record: AddressRecord) => Promise<void>;
  removeAddress: (address: string) => Promise<void>;
  /** Sets or clears the From display name; an empty string clears it. */
  setSenderName: (address: string, senderName: string) => Promise<void>;
};

const MailContext = createContext<MailContextValue | null>(null);

const upsertRecord = (current: readonly AddressRecord[], record: AddressRecord) => [
  ...current.filter(candidate => candidate.address !== record.address),
  record,
];

export const MailProvider = ({ children }: { children: ReactNode }) => {
  const { session } = useVault();
  const demo = isDemo();

  const [records, setRecords] = useState<readonly AddressRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [demoThreads, setDemoThreads] = useState<readonly ThreadState[]>([]);
  /** What the server last said, per account. Never patched: `ops` is laid over it at render (`lib/reconcile.ts`). */
  const [baseByAccount, setBaseByAccount] = useState<AccountSummaries>({});
  const [bodiesById, setBodiesById] = useState<Readonly<Record<string, BodyEntry>>>({});
  /** Cached body text by location, so a row has its excerpt before anyone opens the message. */
  const [previews, setPreviews] = useState<Previews>({});
  const [ops, setOps] = useState<readonly PendingOp[]>([]);
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, AccountSyncState>>>({});
  const [liveStates, setLiveStates] = useState<Readonly<Record<string, LiveState>>>({});
  const [flagError, setFlagError] = useState<string | null>(null);
  const inFlightBodiesRef = useRef<Map<string, Promise<BodyOutcome>>>(new Map());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [olderInFlight, setOlderInFlight] = useState<Readonly<Record<string, boolean>>>({});

  /** One entry per account with a sync running; `dirty` makes the loop go round again, so every request is followed by a sync that started after it. */
  const syncRunsRef = useRef<Map<string, { promise: Promise<void>; dirty: boolean }>>(new Map());
  /** Counts sync starts; an acked op is retired by the first later one to land. */
  const syncSeqRef = useRef(0);
  /** Keyed by account and folder: two mailboxes over the same folder are one page. */
  const inFlightOlderRef = useRef<Map<string, Promise<void>>>(new Map());
  const liveManagerRef = useRef<LiveManager | null>(null);
  const syncRef = useRef<(address?: string) => Promise<void>>(async () => {});
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  /** Accounts whose cached threads have been read into memory this unlock. */
  const hydratedRef = useRef<Set<string>>(new Set());
  const sessionGeneration = useRef(0);

  const putAddress = useCallback(
    async (record: AddressRecord) => {
      if (!isDemo()) {
        // Unreachable while locked; refuse rather than hold an address that looks stored and is not.
        if (session === null) throw new Error('The vault is locked; nothing can be stored.');
        await session.store.put({
          type: ADDRESS_RECORD_TYPE,
          naturalKey: record.address,
          plaintext: JSON.stringify(record),
        });
      }
      setRecords(current => upsertRecord(current, record));
    },
    [session],
  );

  const removeAddress = useCallback(
    async (address: string) => {
      if (!isDemo()) {
        if (session === null) throw new Error('The vault is locked; nothing can be removed.');
        await session.store.remove(ADDRESS_RECORD_TYPE, address);
        hydratedRef.current.delete(address);
        await liveManagerRef.current?.close(address);
        // An in-flight sync of this account sees `isStale` and skips its cache write, so the clear lands last.
        await syncRunsRef.current.get(address)?.promise;
        const { createMailCache } = await import('../threads/cache');
        await createMailCache(session.userId, address).clear();
      }
      setRecords(current => current.filter(record => record.address !== address));
      setBaseByAccount(current => {
        const { [address]: _, ...rest } = current;
        return rest;
      });
      setOps(current => current.filter(op => op.account !== address));
      // All of them: a `mid/<Message-ID>` id carries no account, and a body kept under one could
      // later be shown for a different message.
      setBodiesById({});
      setPreviews(current => withoutAccountPreviews(current, address));
      setSyncStates(current => {
        const { [address]: _, ...rest } = current;
        return rest;
      });
      setLiveStates(current => {
        const { [address]: _, ...rest } = current;
        return rest;
      });
    },
    [session],
  );

  const setSenderName = useCallback(
    async (address: string, senderName: string) => {
      const current = records.find(record => record.address === address);
      if (current === undefined) return;
      const { senderName: _, ...rest } = current;
      await putAddress(
        senderName.trim() === '' ? rest : { ...rest, senderName: senderName.trim() },
      );
    },
    [putAddress, records],
  );

  const runOn = useCallback(
    (account: InboundAddress) =>
      <T,>(task: LiveTask<T>): Promise<Result<T, MailConnectionFailure>> => {
        const manager = liveManagerRef.current;
        if (manager === null) {
          return Promise.resolve({
            ok: false,
            error: { kind: 'error', detail: 'The vault is locked' },
          });
        }
        return manager.run(account, task);
      },
    [],
  );

  const identities = records;

  const accounts = useMemo(() => records.filter(isInbound), [records]);
  const ownedAddresses = useMemo(() => records.map(record => record.address), [records]);

  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const requestSync = useCallback(
    (account: InboundAddress): Promise<void> => {
      const address = account.address;
      const running = syncRunsRef.current.get(address);
      if (running !== undefined) {
        running.dirty = true;
        return running.promise;
      }

      const generation = sessionGeneration.current;
      const userId = userIdRef.current;
      if (userId === null) return Promise.resolve();
      const entry = { dirty: false, promise: Promise.resolve() };
      entry.promise = (async () => {
        try {
          const [
            { syncAccount, cachedSummaries, cachedPreviews, prefetchBodies },
            { createMailCache },
          ] = await Promise.all([import('../threads/sync'), import('../threads/cache')]);
          const cache = createMailCache(userId, address);
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === address);
          // The cache is the list until the server answers.
          if (!hydratedRef.current.has(address)) {
            hydratedRef.current.add(address);
            const [cached, cachedText] = await Promise.all([
              cachedSummaries(cache),
              cachedPreviews(cache, address),
            ]);
            if (isStale()) return;
            if (Object.values(cached).some(folder => folder.summaries.length > 0)) {
              setBaseByAccount(current => ({ ...current, [address]: cached }));
            }
            setPreviews(current => ({ ...current, ...cachedText }));
          }
          do {
            entry.dirty = false;
            syncSeqRef.current += 1;
            const seq = syncSeqRef.current;
            setSyncStates(current => ({ ...current, [address]: { status: 'syncing' } }));
            const result = await syncAccount(runOn(account), cache, isStale);
            if (generation !== sessionGeneration.current) return;
            // A UIDVALIDITY reset dropped the cache; the threads on screen and the ops against them name invalid uids.
            if (result.state.status === 'failed' && result.state.invalidated) {
              setBaseByAccount(current => ({ ...current, [address]: {} }));
              setPreviews(current => withoutAccountPreviews(current, address));
              setOps(current => current.filter(op => op.account !== address));
            }
            if (result.state.status === 'synced') {
              setBaseByAccount(current => ({ ...current, [address]: result.byFolder }));
              // This pass started after the acks it retires, on the same serial queue as their commands.
              setOps(current => retireOps(current, address, seq));
              // The server's flags just arrived; an earlier refused write is moot.
              setFlagError(null);
              prefetchBodies(
                runOn(account),
                cache,
                result.byFolder,
                MAX_CACHED_BODY_BYTES,
                30,
                isStale,
                (at, body) => {
                  if (isStale()) return;
                  setPreviews(current => ({
                    ...current,
                    [previewKey({ account: address, ...at })]: body.paragraphs,
                  }));
                },
              );
            }
            setSyncStates(current => ({ ...current, [address]: result.state }));
          } while (entry.dirty);
        } catch (error) {
          if (generation !== sessionGeneration.current) return;
          setSyncStates(current => ({
            ...current,
            [address]: {
              status: 'failed',
              failure: {
                kind: 'error',
                detail: error instanceof Error ? error.message : String(error),
              },
              at: Date.now(),
            },
          }));
        } finally {
          syncRunsRef.current.delete(address);
        }
      })();

      syncRunsRef.current.set(address, entry);
      return entry.promise;
    },
    [runOn],
  );

  const sync = useCallback(
    async (address?: string): Promise<void> => {
      if (isDemo()) return;
      const currentAccounts = accountsRef.current;
      if (address !== undefined) {
        const account = currentAccounts.find(candidate => candidate.address === address);
        if (account !== undefined) {
          await requestSync(account);
        }
        return;
      }
      await Promise.all(currentAccounts.map(account => requestSync(account)));
    },
    [requestSync],
  );
  syncRef.current = sync;

  /** Read by the draft writes, which run outside a render. */
  const threadsRef = useRef<readonly ThreadState[]>([]);
  const { slice, load, reset, setDrafts, drafts, vaultSent } = useComposer({
    session,
    identities,
    accounts,
    runOn,
    sync,
    threadsRef,
    baseByAccount,
    demo,
  });

  // Keyed on the store, not the session object: a mode switch in Settings hands out a new session
  // over the same store and user, and that must not restart the mail session or clear its cache.
  const store = session?.store ?? null;
  const userId = session?.userId ?? null;
  useEffect(() => {
    if (import.meta.env.DEV && isDemo()) {
      // Dynamic so the fixture module stays out of the production bundle; the `DEV` guard is what
      // lets Vite drop the branch.
      void import('../dev/fixtures').then(({ DEMO_ADDRESSES, THREADS }) => {
        setRecords(DEMO_ADDRESSES);
        setDemoThreads(
          THREADS.map(thread => ({
            ...thread,
            folders: ['inbox'] as const,
            foldersByAccount: Object.fromEntries(
              thread.accounts.map(account => [account, ['inbox'] as const]),
            ),
          })),
        );
      });
      setRecordsError(null);
      return;
    }
    if (store === null || userId === null) return;
    let cancelled = false;
    setRecordsError(null);
    void (async () => {
      const [{ createLiveManager }, { connectImap }] = await Promise.all([
        import('../relay/live'),
        import('../relay/connection'),
      ]);
      if (cancelled) return;
      liveManagerRef.current = createLiveManager({
        connect: connectImap,
        onState: (address, state) => setLiveStates(current => ({ ...current, [address]: state })),
        onMailboxChanged: address => {
          void syncRef.current(address);
        },
        // A tab unlocked in the background must not hold connections open for ever.
        visible: !document.hidden,
      });
      try {
        const listed = await store.list(ADDRESS_RECORD_TYPE);
        const parsed = listed.flatMap(row => {
          const record = parseAddressRecord(row.plaintext);
          if (record === null) {
            // biome-ignore lint/suspicious/noConsole: unreadable vault rows must surface without aborting the list
            console.warn(`address record ${row.naturalKey} unreadable`);
            return [];
          }
          return [record];
        });
        if (!cancelled) setRecords(parsed);
        await load(store, parsed, () => cancelled);
      } catch (err) {
        if (!cancelled) setRecordsError(vaultErrorMessage(err));
      }
    })();
    // The teardown belongs to the session it set up, so it runs the same way for a lock, for a
    // sign-in that replaces this session with another account's, and for the tab going away.
    return () => {
      cancelled = true;
      // Bump the generation first: an in-flight sync checks it (`isStale`) before writing, so the
      // cache clear below cannot race a late write back in.
      sessionGeneration.current += 1;
      // Otherwise the next unlock's sync is handed the old in-flight promise.
      syncRunsRef.current.clear();
      inFlightOlderRef.current.clear();
      inFlightBodiesRef.current.clear();
      hydratedRef.current.clear();
      const manager = liveManagerRef.current;
      liveManagerRef.current = null;
      void (async () => {
        // The running task finishes before the clear, or a late write lands in the emptied cache.
        if (manager !== null) await manager.closeAll();
        const { clearMailCache } = await import('../threads/cache');
        await clearMailCache(userId).catch(() => {});
      })();
      setRecords([]);
      setRecordsError(null);
      setBaseByAccount({});
      setBodiesById({});
      setPreviews({});
      setOps([]);
      setSyncStates({});
      setLiveStates({});
      setOlderInFlight({});
      reset(userId);
      setFlagError(null);
    };
  }, [store, userId, load, reset]);

  /** One account's next window of a folder. A refused page reports like a refused flag write. */
  const loadOlderOn = useCallback(
    async (account: InboundAddress, folder: Folder): Promise<void> => {
      const key = `${account.address}/${folder}`;
      const inFlight = inFlightOlderRef.current.get(key);
      if (inFlight !== undefined) return inFlight;

      const generation = sessionGeneration.current;
      const userId = userIdRef.current;
      if (userId === null) return;
      const promise = (async () => {
        try {
          const [{ loadOlder: loadOlderPage, cachedSummaries }, { createMailCache }] =
            await Promise.all([import('../threads/sync'), import('../threads/cache')]);
          const cache = createMailCache(userId, account.address);
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === account.address);
          const res = await loadOlderPage(runOn(account), cache.folder(folder), isStale);
          if (generation !== sessionGeneration.current) return;
          if (!res.ok) {
            setFlagError(describeMailFailure(res.error, account.imap.host));
            return;
          }
          const summaries = await cachedSummaries(cache);
          if (generation !== sessionGeneration.current) return;
          setBaseByAccount(current => ({ ...current, [account.address]: summaries }));
          setFlagError(null);
          if (!res.value.complete) return;
          setSyncStates(current => {
            const state = current[account.address];
            if (state?.status !== 'synced' || state.complete.includes(folder)) return current;
            return {
              ...current,
              [account.address]: { ...state, complete: [...state.complete, folder] },
            };
          });
        } catch (error) {
          if (generation !== sessionGeneration.current) return;
          setFlagError(
            describeMailFailure(
              { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
              account.imap.host,
            ),
          );
        }
      })().finally(() => {
        inFlightOlderRef.current.delete(key);
      });

      inFlightOlderRef.current.set(key, promise);
      return promise;
    },
    [runOn],
  );

  const loadOlder = useCallback(
    async (mailbox: MailboxId): Promise<void> => {
      if (isDemo()) return;
      const folder = folderPaged(mailbox);
      const targets = accountsShown(accountsRef.current, mailbox);
      if (targets.length === 0) return;
      setOlderInFlight(current => ({ ...current, [mailbox]: true }));
      try {
        await Promise.all(targets.map(account => loadOlderOn(account, folder)));
      } finally {
        setOlderInFlight(current => ({ ...current, [mailbox]: false }));
      }
    },
    [loadOlderOn],
  );

  // A rename or a new send-only identity must not reopen IMAP for every account; credentials are in the key.
  const inboundKey = useMemo(
    () =>
      accounts
        .map(
          a => `${a.address}|${a.imap.host}|${a.imap.port}|${a.imap.username}|${a.imap.password}`,
        )
        .sort()
        .join('\n'),
    [accounts],
  );
  useEffect(() => {
    if (isDemo() || inboundKey === '') return;
    void sync();
    // `sync` reads accounts through a ref, so the key is the only real dependency.
  }, [inboundKey, sync]);

  useEffect(() => {
    if (isDemo()) return;
    const onVisibility = () => {
      const visible = !document.hidden;
      liveManagerRef.current?.setVisible(visible);
      if (visible) void sync();
    };
    const onOnline = () => {
      void sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [sync]);

  // The server's last word, with bodies merged in and pending ops laid over it on every render.
  const threads = useMemo(() => {
    if (demo) return demoThreads;
    // One grouping pass over every account, or a conversation two addresses are copied on splits in two.
    return withDrafts(
      applyOps(
        withBodies(threadsFromAccounts(baseByAccount, vaultSent), bodiesById, previews),
        ops,
      ),
      drafts,
    );
  }, [demo, demoThreads, baseByAccount, vaultSent, bodiesById, previews, ops, drafts]);

  threadsRef.current = threads;

  /** The op keeps masking the base until a sync that started after this moment lands. */
  const acknowledge = useCallback(
    (op: PendingOp, account: InboundAddress) => {
      const retireAtSyncSeq = syncSeqRef.current + 1;
      setOps(current =>
        current.map(candidate =>
          candidate.id === op.id ? { ...candidate, retireAtSyncSeq } : candidate,
        ),
      );
      setFlagError(null);
      void requestSync(account);
    },
    [requestSync],
  );

  /** While a move is pending the messages' synced locations name uids the server is about to change. */
  const isMoving = useCallback(
    (threadId: string) => {
      if (!ops.some(op => op.threadId === threadId && op.change.kind === 'move')) return true;
      setFlagError('Still confirming the last move of that conversation; try again in a moment.');
      return false;
    },
    [ops],
  );

  /**
   * One optimistic write against the server's copies: an op showing the thread as it is about
   * to be, then one IMAP command per account (its own connection, sync and uid space) over the
   * locations `pick` keeps, grouped by folder because a uid only means something in its own
   * mailbox. A refused command drops that account's op and lands in `flagError`, never in the
   * account's sync state.
   */
  const runThreadOp = useCallback(
    (
      threadId: string,
      change: PendingChange,
      pick: (location: MailLocation) => boolean,
      command: (
        run: ReturnType<typeof runOn>,
        targets: readonly FlagTarget[],
      ) => Promise<Result<unknown, MailConnectionFailure>>,
    ): boolean => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      if (isDemo()) {
        setDemoThreads(current =>
          applyOps(current, [
            { id: crypto.randomUUID(), account: '', threadId, change, retireAtSyncSeq: null },
          ]),
        );
        return true;
      }
      if (!isMoving(threadId)) return false;

      const byAccount = Map.groupBy(
        thread.messages.flatMap(message => (message.locations ?? []).filter(pick)),
        location => location.account,
      );
      const userId = userIdRef.current;
      const work = [...byAccount].flatMap(([address, locations]) => {
        const account = accountsRef.current.find(a => a.address === address);
        return account === undefined
          ? []
          : [{ account, uidsByFolder: Map.groupBy(locations, location => location.folder) }];
      });
      // Nothing on the server to change, so no op: it would mask a base that is already right.
      if (userId === null || work.length === 0) return false;

      // One op per account, retired by its own account's confirming sync.
      const ops = work.map(({ account }) => ({
        id: crypto.randomUUID(),
        account: account.address,
        threadId,
        change,
        retireAtSyncSeq: null,
      }));
      setOps(current => [...current, ...ops]);

      for (const [index, { account, uidsByFolder }] of work.entries()) {
        const op = ops[index];
        if (op === undefined) continue;
        void (async () => {
          let failure: MailConnectionFailure;
          try {
            const { createMailCache } = await import('../threads/cache');
            const cache = createMailCache(userId, account.address);
            const targets = await Promise.all(
              [...uidsByFolder].map(async ([folder, locations]) => {
                const mark = await cache.folder(folder).getSync();
                if (mark === null) throw new Error(`${folder} has not synced`);
                assertSameUidValidity(folder, mark.uidValidity, locations);
                return {
                  mailbox: mark.name,
                  uidValidity: mark.uidValidity,
                  uids: locations.map(({ uid }) => uid),
                };
              }),
            );
            const res = await command(runOn(account), targets);
            if (res.ok) {
              acknowledge(op, account);
              return;
            }
            failure = res.error;
          } catch (err) {
            failure = { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
          }
          setOps(current => current.filter(candidate => candidate.id !== op.id));
          setFlagError(describeMailFailure(failure, account.imap.host));
          // A half-done move must not stay masked: the sync says which half happened.
          if (change.kind === 'move') void requestSync(account);
        })();
      }
      return true;
    },
    [acknowledge, isMoving, requestSync, runOn, threads],
  );

  const setThreadFlag = useCallback(
    (threadId: string, key: 'isUnread' | 'isStarred', value: boolean): boolean => {
      const imapFlag = key === 'isUnread' ? '\\Seen' : '\\Flagged';
      const on = key === 'isUnread' ? !value : value;
      return runThreadOp(
        threadId,
        { kind: 'flag', key, value },
        () => true,
        async (run, targets) => {
          const { setFlag } = await import('../threads/sync');
          return setFlag(run, targets, imapFlag, on);
        },
      );
    },
    [runThreadOp],
  );

  const loadBody = useCallback(
    (threadId: string, messageId: string): Promise<BodyOutcome> => {
      const failed = { status: 'failed' } as const;
      const thread = threads.find(t => t.id === threadId);
      const message = thread?.messages.find(m => m.id === messageId);
      if (message === undefined || thread === undefined) return Promise.resolve(failed);
      if (message.bodyStatus === undefined) {
        const { body, html, hasTextPart, inlineImagesTruncated, attachments } = message;
        return Promise.resolve({
          status: 'loaded',
          body,
          html,
          hasTextPart,
          inlineImagesTruncated,
          attachments,
        });
      }
      // A second caller awaits the same fetch.
      const inFlight = inFlightBodiesRef.current.get(messageId);
      if (inFlight !== undefined) return inFlight;

      const userId = userIdRef.current;
      // Any copy will do for a body.
      const [copy] = message.locations ?? [];
      if (copy === undefined || userId === null) return Promise.resolve(failed);
      const { folder, uid, account: accountAddress } = copy;
      const account = accountsRef.current.find(a => a.address === accountAddress);
      if (account === undefined) return Promise.resolve(failed);

      const setEntry = (entry: BodyEntry) =>
        setBodiesById(current => ({ ...current, [messageId]: entry }));
      setEntry({ status: 'loading' });
      const generation = sessionGeneration.current;
      const promise = (async (): Promise<BodyOutcome> => {
        try {
          const [{ fetchBody }, { createMailCache }] = await Promise.all([
            import('../threads/bodies'),
            import('../threads/cache'),
          ]);
          const cache = createMailCache(userId, accountAddress).folder(folder);
          const cached = await cache.getBody(uid);
          const fetchFresh = async () => {
            const mark = await cache.getSync();
            if (mark === null) throw new Error(`${folder} has not synced`);
            // Same guard as the writes: a stale uid would fetch whatever now holds that number.
            assertSameUidValidity(folder, mark.uidValidity, [copy]);
            return fetchBody(runOn(account), mark.name, uid, message.rawSize);
          };
          const res = cached !== null ? { ok: true as const, value: cached } : await fetchFresh();
          if (generation !== sessionGeneration.current) return failed;
          if (!res.ok) {
            setEntry(failed);
            setFlagError(describeMailFailure(res.error, account.imap.host));
            return failed;
          }
          if (
            cached === null &&
            (message.rawSize ?? Number.POSITIVE_INFINITY) <= MAX_CACHED_BODY_BYTES
          ) {
            // Best effort: a body that did not cache is fetched again next time.
            await cache.putBody(uid, res.value).catch(() => {});
          }
          const loaded: BodyOutcome = {
            status: 'loaded',
            body: res.value.paragraphs,
            html: res.value.html,
            hasTextPart: res.value.hasTextPart,
            inlineImagesTruncated: res.value.inlineImagesTruncated,
            attachments: res.value.attachments,
          };
          setEntry(loaded);
          setFlagError(null);
          return loaded;
        } catch (err) {
          if (generation !== sessionGeneration.current) return failed;
          setEntry(failed);
          setFlagError(
            describeMailFailure(
              { kind: 'error', detail: err instanceof Error ? err.message : String(err) },
              account.imap.host,
            ),
          );
          return failed;
        } finally {
          inFlightBodiesRef.current.delete(messageId);
        }
      })();
      inFlightBodiesRef.current.set(messageId, promise);
      return promise;
    },
    [runOn, threads],
  );

  const markRead = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined || !thread.isUnread) return true;
      return setThreadFlag(threadId, 'isUnread', false);
    },
    [setThreadFlag, threads],
  );

  const markUnread = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined || thread.isUnread) return true;
      return setThreadFlag(threadId, 'isUnread', true);
    },
    [setThreadFlag, threads],
  );

  const toggleStar = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      return setThreadFlag(threadId, 'isStarred', !thread.isStarred);
    },
    [setThreadFlag, threads],
  );

  /**
   * One optimistic folder move: `UID MOVE` per source folder, then a sync. One MOVE per mailbox
   * cannot be atomic across them, so the sync says which half happened.
   */
  const moveThreadTo = useCallback(
    (threadId: string, to: MoveTarget): boolean => {
      const sources = MOVE_SOURCES[to];
      return runThreadOp(
        threadId,
        { kind: 'move', to },
        // Only the copies this move consumes, in every account that holds one.
        location => sources.includes(location.folder),
        async (run, targets) => {
          const { moveThread } = await import('../threads/sync');
          return moveThread(run, targets, to);
        },
      );
    },
    [runThreadOp],
  );

  const toggleArchive = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      return moveThreadTo(threadId, isArchived(thread) ? 'inbox' : 'archive');
    },
    [moveThreadTo, threads],
  );

  const trashThread = useCallback(
    (threadId: string) => moveThreadTo(threadId, 'trash'),
    [moveThreadTo],
  );

  const restoreThread = useCallback(
    (threadId: string) => moveThreadTo(threadId, 'inbox'),
    [moveThreadTo],
  );

  /**
   * HACKATHON ONLY (see `judge/`). The cache is dropped, not reconciled: the fixtures come back
   * with new uids. The vault's drafts go with the wipe, since the IMAP Drafts folder is emptied
   * by the same pass.
   */
  const resetDemoInbox = useCallback(async () => {
    const userId = userIdRef.current;
    const session = sessionRef.current;
    // By name, never `accounts[0]`: a vault may hold a judge alias beside another address.
    const account = accounts.find(candidate => isJudgeAddress(candidate.address));
    if (userId === null || session === null || account === undefined) {
      return 'No demo mailbox is connected to this vault.';
    }
    const [{ resetJudgeInbox }, { createMailCache }, { listDrafts, deleteDraft }] =
      await Promise.all([
        import('../dev/judge/reset'),
        import('../threads/cache'),
        import('../compose/draft-vault'),
      ]);
    const outcome = await runOn(account)(resetJudgeInbox(account.address));
    if (!outcome.ok) return 'The mailbox could not be reached; try again in a moment.';
    // Only the judge account's drafts; best effort per draft.
    const drafts = await listDrafts(session.store);
    for (const draft of drafts) {
      if ((draft.record.ownerAccount ?? draft.record.from) !== account.address) continue;
      await deleteDraft(session.store, draft.draftId, Date.now());
    }
    setDrafts(await listDrafts(session.store));
    await createMailCache(userId, account.address).clear();
    await syncRef.current(account.address);
    const { wiped, appended, missing } = outcome.value;
    if (missing.length > 0) {
      // A fixture that never landed takes a beat of the judge's script with it.
      return `Reset incomplete — ${missing.length} message(s) did not land (${missing.join(', ')}). Try again.`;
    }
    return `Inbox reset: ${wiped} message(s) cleared, ${appended} demo messages restored.`;
  }, [accounts, runOn, setDrafts]);

  const value = useMemo<MailContextValue>(
    () => ({
      accounts,
      identities,
      ownedAddresses,
      threads,
      ...slice,
      isDemo: demo,
      recordsError,
      flagError,
      syncStates,
      liveStates,
      sync,
      loadOlder,
      isLoadingOlder: mailbox => olderInFlight[mailbox] === true,
      putAddress,
      removeAddress,
      setSenderName,
      markRead,
      markUnread,
      toggleStar,
      loadBody,
      toggleArchive,
      trashThread,
      restoreThread,
      resetDemoInbox,
    }),
    [
      slice,
      accounts,
      identities,
      ownedAddresses,
      threads,
      demo,
      recordsError,
      flagError,
      syncStates,
      liveStates,
      sync,
      loadOlder,
      olderInFlight,
      putAddress,
      removeAddress,
      setSenderName,
      markRead,
      markUnread,
      toggleStar,
      loadBody,
      toggleArchive,
      trashThread,
      restoreThread,
      resetDemoInbox,
    ],
  );

  return <MailContext value={value}>{children}</MailContext>;
};

export const useMail = () => {
  const value = use(MailContext);
  if (value === null) throw new Error('useMail must be used inside <MailProvider>');
  return value;
};
