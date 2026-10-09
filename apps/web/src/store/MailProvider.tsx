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
import { clearCachedFrames } from '../threads/frame-cache';
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
import { type Folder, isArchived, isServerCopy } from '../threads/thread';
import { accountsShown, folderPaged, type MailboxId } from '../threads/views';
import { isDemo } from '../ui/chrome';
import { toast } from '../ui/Toast';
import { vaultErrorMessage } from '../vault/screen-policy';
import { useVault } from '../vault/session';
import { type Composer, useComposer } from './use-composer';

/**
 * Threads are held in memory only: a lock drops them. The contexts' IO modules are reached through
 * dynamic imports so the TLS stack and root bundle stay out of the entry chunk.
 */

type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

/** Hears why a move was refused, on the spot or once the server answers: once, however many accounts refused it. */
type OnRefused = (reason: string) => void;

type MailContextValue = Composer & {
  accounts: readonly InboundAddress[];
  identities: readonly AddressRecord[];
  /** Every address you own, inbound or send-only. */
  ownedAddresses: readonly string[];
  threads: readonly ThreadState[];
  isDemo: boolean;
  recordsError: string | null;
  /** What last failed (a flag write, a move, a body, an older page) and why; cleared by the next one that works. */
  mailError: string | null;
  syncStates: Readonly<Record<string, AccountSyncState>>;
  liveStates: Readonly<Record<string, LiveState>>;
  sync: (address?: string) => Promise<void>;
  /** Pages one window further back, on every account this mailbox shows. Coalesced per account and folder. */
  loadOlder: (mailbox: MailboxId) => Promise<void>;
  /** Whether that mailbox's page is in flight. */
  isLoadingOlder: (mailbox: MailboxId) => boolean;
  /** Flag and move answer `false` (and set `mailError`) while a move of the same thread is pending. */
  markRead: (threadId: string) => boolean;
  /** Puts the whole thread back to unread; the reader closes with it. */
  markUnread: (threadId: string) => boolean;
  toggleStar: (threadId: string) => boolean;
  /** Fetches a body, joining a fetch in flight, and resolves with the outcome itself. */
  loadBody: (threadId: string, messageId: string) => Promise<BodyOutcome>;
  toggleArchive: (threadId: string, onRefused?: OnRefused) => boolean;
  /** Moves the whole conversation to Trash, own sent copies included. */
  trashThread: (threadId: string, onRefused?: OnRefused) => boolean;
  /** Brings a thread back to the inbox from Trash or Archive. */
  restoreThread: (threadId: string, onRefused?: OnRefused) => boolean;
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

/**
 * Resolves in the task after the next frame is drawn, so state set before the call is on screen
 * first. A hidden tab draws no frames: there it waits until the tab is shown.
 */
const afterNextPaint = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

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
  const [mailError, setMailError] = useState<string | null>(null);
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

  /**
   * Removals from the moment the vault delete is sent until their teardown ends. Adding the address
   * back waits for one: a PUT that overtook the delete would be erased by it, and a teardown that
   * outlived the PUT would clear the new address's cache.
   */
  const removalsRef = useRef<Map<string, Promise<void>>>(new Map());

  const storeAddress = useCallback(
    async (record: AddressRecord) => {
      if (isDemo()) return;
      // Unreachable while locked; refuse rather than hold an address that looks stored and is not.
      if (session === null) throw new Error('The vault is locked; nothing can be stored.');
      await session.store.put({
        type: ADDRESS_RECORD_TYPE,
        naturalKey: record.address,
        plaintext: JSON.stringify(record),
      });
    },
    [session],
  );

  /** Stored before it shows: an inbound address starts syncing the moment it renders. */
  const putAddress = useCallback(
    async (record: AddressRecord) => {
      const generation = sessionGeneration.current;
      await removalsRef.current.get(record.address);
      if (generation !== sessionGeneration.current) {
        throw new Error('The vault was locked; nothing was stored.');
      }
      await storeAddress(record);
      setRecords(current => upsertRecord(current, record));
    },
    [storeAddress],
  );

  /**
   * The vault delete is the commit point and nothing changes before it, so a refusal leaves the
   * address as it was. After it the address and its mail leave the screen, and the slow half runs
   * off the button: the connection closes, a sync still running finishes without writing
   * (`isStale`), the cache is cleared, and only then does the sync and live state those two still
   * report go.
   */
  const removeAddress = useCallback(
    async (address: string) => {
      if (!isDemo()) {
        if (session === null) throw new Error('The vault is locked; nothing can be removed.');
        const generation = sessionGeneration.current;
        const { store, userId } = session;
        const removal = Promise.withResolvers<void>();
        removalsRef.current.set(address, removal.promise);
        const settle = () => {
          // A later session's removal of the same address may hold the slot by now.
          if (removalsRef.current.get(address) === removal.promise) {
            removalsRef.current.delete(address);
          }
          removal.resolve();
        };
        try {
          await store.remove(ADDRESS_RECORD_TYPE, address);
        } catch (err) {
          settle();
          throw err;
        }
        // A session that ended meanwhile tore its own mail down and cleared this user's whole cache.
        if (generation !== sessionGeneration.current) {
          settle();
          return;
        }
        // Read at the commit, while they still belong to this session.
        const manager = liveManagerRef.current;
        const running = syncRunsRef.current.get(address)?.promise;
        void (async () => {
          await manager?.close(address);
          await running;
          const { createMailCache } = await import('../threads/cache');
          // A clear that fails is finished by the lock's, which empties every account of this user.
          await createMailCache(userId, address)
            .clear()
            .catch(() => {});
          // The next session's state for an address of the same name is not this removal's to drop.
          if (generation !== sessionGeneration.current) return;
          setSyncStates(current => {
            const { [address]: _, ...rest } = current;
            return rest;
          });
          setLiveStates(current => {
            const { [address]: _, ...rest } = current;
            return rest;
          });
        })().finally(settle);
      }
      // `isStale` reads the ref, so a sync of this address stops writing now, not at the next render.
      accountsRef.current = accountsRef.current.filter(account => account.address !== address);
      hydratedRef.current.delete(address);
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
    },
    [session],
  );

  /** A name touches no connection, so it shows before the vault has it. */
  const setSenderName = useCallback(
    async (address: string, senderName: string) => {
      const previous = records.find(record => record.address === address);
      if (previous === undefined) return;
      const { senderName: _, ...rest } = previous;
      const renamed = senderName.trim() === '' ? rest : { ...rest, senderName: senderName.trim() };
      setRecords(current => current.map(record => (record === previous ? renamed : record)));
      try {
        await storeAddress(renamed);
      } catch (err) {
        // By identity, so a refusal never undoes a later rename that has already replaced this one.
        setRecords(current => current.map(record => (record === renamed ? previous : record)));
        throw err;
      }
    },
    [records, storeAddress],
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
          const { createMailCache } = await import('../threads/cache');
          const cache = createMailCache(userId, address);
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === address);
          // The cache is the list until the server answers.
          if (!hydratedRef.current.has(address)) {
            hydratedRef.current.add(address);
            const { cachedSummaries, cachedPreviews } = await import('../threads/hydrate');
            const [cached, cachedText] = await Promise.all([
              cachedSummaries(cache),
              cachedPreviews(cache, address),
            ]);
            if (isStale()) return;
            if (Object.values(cached).some(folder => folder.summaries.length > 0)) {
              setBaseByAccount(current => ({ ...current, [address]: cached }));
            }
            setPreviews(current => ({ ...current, ...cachedText }));
            // The rows above are only scheduled, and the import below starts fetching the TLS /
            // IMAP stack at once; one that arrived from the HTTP cache would run before the paint.
            await afterNextPaint();
            if (isStale()) return;
          }
          const { syncAccount, prefetchBodies } = await import('../threads/sync');
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
              setMailError(null);
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
          // A run that outlived its session finds the next session's run in its slot.
          if (syncRunsRef.current.get(address) === entry) syncRunsRef.current.delete(address);
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
  const { slice, load, reset, drafts, vaultSent } = useComposer({
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
      try {
        const [live, listed] = await Promise.allSettled([
          import('../relay/live'),
          store.list(ADDRESS_RECORD_TYPE),
        ]);
        if (cancelled) return;
        if (live.status === 'rejected') throw live.reason;
        // Before the records, so every task an address can start finds it, and whatever the list
        // says: an address added after a refused list still syncs through it.
        liveManagerRef.current = live.value.createLiveManager({
          // The TLS stack loads with the first connection, which the sync opens only after the
          // cached list has painted; importing it here would hold the paint behind it.
          connect: async (imap, options) => {
            let connection: typeof import('../relay/connection');
            try {
              connection = await import('../relay/connection');
            } catch (error) {
              // Offline with the cache on screen: refused like an unreachable host, never thrown
              // into the queue.
              return {
                ok: false,
                error: {
                  kind: 'error',
                  detail: error instanceof Error ? error.message : String(error),
                },
              };
            }
            return connection.connectImap(imap, options);
          },
          // A connection of an ended session still reports its close; the next session's are not its to set.
          onState: (address, state) => {
            if (!cancelled) setLiveStates(current => ({ ...current, [address]: state }));
          },
          onMailboxChanged: address => {
            if (!cancelled) void syncRef.current(address);
          },
          // A tab unlocked in the background must not hold connections open for ever.
          visible: !document.hidden,
        });
        if (listed.status === 'rejected') throw listed.reason;
        const parsed = listed.value.flatMap(row => {
          const record = parseAddressRecord(row.plaintext);
          if (record === null) {
            // biome-ignore lint/suspicious/noConsole: unreadable vault rows must surface without aborting the list
            console.warn(`address record ${row.naturalKey} unreadable`);
            return [];
          }
          return [record];
        });
        setRecords(parsed);
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
      clearCachedFrames();
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
      setMailError(null);
      // Every toast reports on this session's mail, and one that waits to be read would wait for
      // whoever unlocks next.
      toast.close();
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
          const [{ loadOlder: loadOlderPage }, { cachedSummaries }, { createMailCache }] =
            await Promise.all([
              import('../threads/sync'),
              import('../threads/hydrate'),
              import('../threads/cache'),
            ]);
          const cache = createMailCache(userId, account.address);
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === account.address);
          const res = await loadOlderPage(runOn(account), cache.folder(folder), isStale);
          if (generation !== sessionGeneration.current) return;
          if (!res.ok) {
            setMailError(
              `older mail not loaded · ${describeMailFailure(res.error, account.imap.host)}`,
            );
            return;
          }
          const summaries = await cachedSummaries(cache);
          if (generation !== sessionGeneration.current) return;
          setBaseByAccount(current => ({ ...current, [account.address]: summaries }));
          setMailError(null);
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
          setMailError(
            `older mail not loaded · ${describeMailFailure(
              { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
              account.imap.host,
            )}`,
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
      setMailError(null);
      void requestSync(account);
    },
    [requestSync],
  );

  /** While a move is pending the messages' synced locations name uids the server is about to change. */
  const isMoving = useCallback(
    (threadId: string, onRefused?: OnRefused) => {
      if (!ops.some(op => op.threadId === threadId && op.change.kind === 'move')) return true;
      const reason = 'Still confirming the last move of that conversation; try again in a moment.';
      setMailError(reason);
      onRefused?.(reason);
      return false;
    },
    [ops],
  );

  /**
   * One optimistic write against the server's copies: one IMAP command per account (its own
   * connection, sync and uid space), grouped by folder because a uid only means something in its
   * own mailbox. A refused command drops that account's op and lands in `mailError`, never in its
   * sync state.
   */
  const runThreadOp = useCallback(
    (
      threadId: string,
      change: PendingChange,
      pick: (folder: Folder) => boolean,
      command: (
        run: ReturnType<typeof runOn>,
        targets: readonly FlagTarget[],
      ) => Promise<Result<unknown, MailConnectionFailure>>,
      onRefused?: OnRefused,
    ): boolean => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      const opFor = (account: string): PendingOp => ({
        id: crypto.randomUUID(),
        account,
        threadId,
        change,
        retireAtSyncSeq: null,
      });
      if (isDemo()) {
        // Demo moves never touch the fixtures' locations, so the folders say who holds a copy.
        const ops = Object.entries(thread.foldersByAccount)
          .filter(([, folders]) => folders.some(pick))
          .map(([account]) => opFor(account));
        if (ops.length === 0) return false;
        setDemoThreads(current => applyOps(current, ops));
        return true;
      }
      if (!isMoving(threadId, onRefused)) return false;

      const byAccount = Map.groupBy(
        thread.messages.flatMap(message =>
          (message.locations ?? []).filter(
            location => isServerCopy(location) && pick(location.folder),
          ),
        ),
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
      if (userId === null || work.length === 0) {
        onRefused?.('No copy of it is on a mail server YOZZ reads.');
        return false;
      }

      // One op per account, retired by its own account's confirming sync.
      const ops = work.map(({ account }) => opFor(account.address));
      setOps(current => [...current, ...ops]);

      const generation = sessionGeneration.current;
      // Flipped by the first account to refuse, so a move both accounts refused is reported once.
      let isRefusalReported = false;
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
            // The session the command belonged to may have ended while the server answered.
            if (generation !== sessionGeneration.current) return;
            if (res.ok) {
              acknowledge(op, account);
              return;
            }
            failure = res.error;
          } catch (err) {
            if (generation !== sessionGeneration.current) return;
            failure = { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
          }
          setOps(current => current.filter(candidate => candidate.id !== op.id));
          const reason = describeMailFailure(failure, account.imap.host);
          setMailError(
            `${change.kind === 'move' ? 'thread not moved' : 'flag not saved'} · ${reason}`,
          );
          if (!isRefusalReported) {
            isRefusalReported = true;
            onRefused?.(reason);
          }
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
      const generation = sessionGeneration.current;
      const promise = (async (): Promise<BodyOutcome> => {
        try {
          const [{ fetchBody }, { createMailCache }] = await Promise.all([
            import('../threads/bodies'),
            import('../threads/cache'),
          ]);
          const cache = createMailCache(userId, accountAddress).folder(folder);
          const cached = await cache.getBody(uid);
          if (generation !== sessionGeneration.current) return failed;
          const fetchFresh = async () => {
            // Only the network says "Loading…": a body on the device replaces `pending` directly.
            setEntry({ status: 'loading' });
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
            setMailError(
              `message not loaded · ${describeMailFailure(res.error, account.imap.host)}`,
            );
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
          setMailError(null);
          return loaded;
        } catch (err) {
          if (generation !== sessionGeneration.current) return failed;
          setEntry(failed);
          setMailError(
            `message not loaded · ${describeMailFailure(
              { kind: 'error', detail: err instanceof Error ? err.message : String(err) },
              account.imap.host,
            )}`,
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
    (threadId: string, to: MoveTarget, onRefused?: OnRefused): boolean => {
      const sources = MOVE_SOURCES[to];
      return runThreadOp(
        threadId,
        { kind: 'move', to },
        // Only the copies this move consumes, in every account that holds one.
        folder => sources.includes(folder),
        async (run, targets) => {
          const { moveThread } = await import('../threads/sync');
          return moveThread(run, targets, to);
        },
        onRefused,
      );
    },
    [runThreadOp],
  );

  const toggleArchive = useCallback(
    (threadId: string, onRefused?: OnRefused) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      return moveThreadTo(threadId, isArchived(thread) ? 'inbox' : 'archive', onRefused);
    },
    [moveThreadTo, threads],
  );

  const trashThread = useCallback(
    (threadId: string, onRefused?: OnRefused) => moveThreadTo(threadId, 'trash', onRefused),
    [moveThreadTo],
  );

  const restoreThread = useCallback(
    (threadId: string, onRefused?: OnRefused) => moveThreadTo(threadId, 'inbox', onRefused),
    [moveThreadTo],
  );

  const value = useMemo<MailContextValue>(
    () => ({
      accounts,
      identities,
      ownedAddresses,
      threads,
      ...slice,
      isDemo: demo,
      recordsError,
      mailError,
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
    }),
    [
      slice,
      accounts,
      identities,
      ownedAddresses,
      threads,
      demo,
      recordsError,
      mailError,
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
    ],
  );

  return <MailContext value={value}>{children}</MailContext>;
};

export const useMail = () => {
  const value = use(MailContext);
  if (value === null) throw new Error('useMail must be used inside <MailProvider>');
  return value;
};
