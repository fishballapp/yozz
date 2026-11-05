import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  isInbound,
  parseAddressRecord,
} from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import {
  type BodyEntry,
  type BodyOutcome,
  MAX_CACHED_BODY_BYTES,
  type Previews,
  previewKey,
  withoutMailboxPreviews,
} from '@yozz.app/mail/threads/body-state';
import type { MailCache } from '@yozz.app/mail/threads/cache';
import { groupThreads, layThreads } from '@yozz.app/mail/threads/hydrate';
import {
  type FolderWindow,
  OLDER_WINDOWS_PER_PAGE,
  windowsOf,
} from '@yozz.app/mail/threads/paging';
import {
  applyOps,
  flagTargets,
  MOVE_SOURCES,
  type MoveTarget,
  type PendingChange,
  type PendingOp,
  retireOps,
} from '@yozz.app/mail/threads/reconcile';
import {
  planOf,
  type ServerSearch,
  type ServerSearchAnswer,
  type ServerSearchFailure,
} from '@yozz.app/mail/threads/server-search';
import type { MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import type {
  FlagTarget,
  MailboxSyncState,
  MovedCopy,
  SyncScope,
} from '@yozz.app/mail/threads/sync';
import { staleMailboxes } from '@yozz.app/mail/threads/sync-staleness';
import type { Location, ThreadState } from '@yozz.app/mail/threads/thread';
import {
  type Folder,
  isArchived,
  isServerCopy,
  senderCheckOf,
} from '@yozz.app/mail/threads/thread';
import {
  folderPaged,
  hasOlderMail,
  listingOf,
  mailboxesShown,
  type ViewId,
} from '@yozz.app/mail/threads/views';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import { type ActivityTracker, createActivityTracker, isUnsavedWork } from '../relay/activity';
import type { LiveManager, RunOn } from '../relay/live';
import { createTxtLookup } from '../threads/dns-over-https';
import { clearCachedFrames } from '../threads/frame-cache';
import { isDemo } from '../ui/chrome';
import { toast } from '../ui/Toast';
import { vaultErrorMessage } from '../vault/screen-policy';
import { useVault } from '../vault/session';
import { type Composer, type ComposerShared, useComposerStore } from './use-composer';
import { useServerSearch } from './use-server-search';

/**
 * Threads are held in memory only: a lock drops them. The contexts' IO modules are reached through
 * dynamic imports so the TLS stack and root bundle stay out of the entry chunk.
 */

type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

/** Hears why a move was refused, on the spot or once the server answers: once, however many mailboxes refused it. */
type OnRefused = (reason: string) => void;

type MailContextValue = ComposerShared & {
  mailboxes: readonly InboundAddress[];
  identities: readonly AddressRecord[];
  /** Every address you own, inbound or send-only. */
  ownedAddresses: readonly string[];
  threads: readonly ThreadState[];
  isDemo: boolean;
  recordsError: string | null;
  /** What last failed (a flag write, a move, a body, an older page) and why; cleared by the next one that works. */
  mailError: string | null;
  syncStates: Readonly<Record<string, MailboxSyncState>>;
  sync: (address?: string) => Promise<void>;
  /** Pages one window further back, on every mailbox this view shows. Coalesced per mailbox and folder. */
  loadOlder: (view: ViewId) => Promise<void>;
  /** Whether that view's page is in flight. */
  isLoadingOlder: (view: ViewId) => boolean;
  /** What each folder has synced, for a list across folders to say how far it reaches. */
  windows: readonly FolderWindow[];
  /** Reads further back in the folder that stops soonest: what is synced, or what a search named. */
  loadOlderInList: (query: string) => Promise<void>;
  isLoadingOlderInList: boolean;
  /** What the box has asked the servers, and how far they have got. */
  serverSearch: ServerSearch | null;
  /** The box's own search: `type` on a keystroke, `now` on Enter, `retry` what failed. */
  search: {
    readonly type: (text: string) => void;
    readonly now: (text: string) => void;
    readonly retry: () => void;
  };
  /** Keeps the search in step with the URL: a `?q=` nobody typed here runs at once. */
  followSearch: (q: string | undefined) => void;
  /** Asks the servers once and waits, with the list holding what they found by the time it answers. */
  askServersAndWait: (text: string) => Promise<{
    readonly answers: readonly ServerSearchAnswer[];
    readonly failed: readonly ServerSearchFailure[];
  }>;
  /** Flag and move answer `false` when no mail server holds a copy to change. */
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
  /**
   * The many-thread forms the actions above are the one-id case of: one write per mailbox and
   * folder however many threads, answering the ids they took (a flag already set counts).
   */
  moveThreads: (
    threadIds: readonly string[],
    to: MoveTarget,
    onRefused?: OnRefused,
  ) => ReadonlySet<string>;
  flagThreads: (
    threadIds: readonly string[],
    key: 'isUnread' | 'isStarred',
    value: boolean,
  ) => ReadonlySet<string>;
  putAddress: (record: AddressRecord) => Promise<void>;
  /** Stores an edit of a stored address, tested by the caller, and makes the running app use it. */
  replaceAddress: (record: AddressRecord) => Promise<void>;
  removeAddress: (address: string) => Promise<void>;
  /** Sets or clears the From display name; an empty string clears it. */
  setSenderName: (address: string, senderName: string) => Promise<void>;
  /** Every piece of mail work in flight, for whatever shows it. */
  activity: ActivityTracker;
};

const MailContext = createContext<MailContextValue | null>(null);
const ComposerContext = createContext<Composer | null>(null);

/** What a runner answers once its session has ended, or before the session's manager exists. */
const VAULT_LOCKED = {
  ok: false,
  error: { kind: 'error', detail: "You're signed out" },
} as const satisfies Result<never, MailConnectionFailure>;

/** What a task answers when the record it was made for has been edited or removed since. */
const ADDRESS_CHANGED = {
  ok: false,
  error: { kind: 'error', detail: 'This address was edited or removed while that was running' },
} as const satisfies Result<never, MailConnectionFailure>;

const upsertRecord = (current: readonly AddressRecord[], record: AddressRecord) => [
  ...current.filter(candidate => candidate.address !== record.address),
  record,
];

/** Whether two records reach the same IMAP server with the same login. */
const sameImap = (a: AddressRecord['imap'], b: AddressRecord['imap']): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.password === b.password);

/**
 * Whether `before` and `after` may be different mailboxes. A new password or port reaches the same
 * one; a new host or login may not, and its mail must not be shown under this address.
 */
const mayBeAnotherMailbox = (before: AddressRecord, after: AddressRecord): boolean =>
  before.imap !== undefined &&
  (after.imap === undefined ||
    after.imap.host !== before.imap.host ||
    after.imap.username !== before.imap.username);

/**
 * Resolves in the task after the next frame is drawn, so state set before the call is on screen
 * first. A hidden tab draws no frames: there it waits until the tab is shown.
 */
const afterNextPaint = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

/** What a write answers when a move before it left a copy somewhere it cannot yet address. */
const MOVE_PENDING = 'Still confirming the last move of that conversation; try again in a moment.';

const locationKey = ({ mailbox, folder, uidValidity, uid }: Location) =>
  `${mailbox}/${folder}/${uidValidity}/${uid}`;

/** Where the server holds `location` now, following each move made since; null where one did not say. */
const whereNow = (
  moved: ReadonlyMap<string, Location | null>,
  location: Location,
): Location | null => {
  const next = moved.get(locationKey(location));
  if (next === undefined) return location;
  return next === null ? null : whereNow(moved, next);
};

const olderNotLoaded = (failure: MailConnectionFailure, { imap }: InboundAddress) =>
  `older mail not loaded · ${describeMailFailure(failure, imap.host)}`;

export const MailProvider = ({ children }: { children: ReactNode }) => {
  const { session } = useVault();
  const demo = isDemo();

  const [records, setRecords] = useState<readonly AddressRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [demoThreads, setDemoThreads] = useState<readonly ThreadState[]>([]);
  const [demoWindows, setDemoWindows] = useState<readonly FolderWindow[]>([]);
  /** What the server last said, per mailbox. Never patched: `ops` is laid over it at render (`lib/reconcile.ts`). */
  const [baseByMailbox, setBaseByMailbox] = useState<MailboxSummaries>({});
  const [bodiesById, setBodiesById] = useState<Readonly<Record<string, BodyEntry>>>({});
  /** Cached body text by location, so a row has its excerpt before anyone opens the message. */
  const [previews, setPreviews] = useState<Previews>({});
  const [ops, setOps] = useState<readonly PendingOp[]>([]);
  /** Read by a sync deciding how much to read. */
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, MailboxSyncState>>>({});
  const syncStatesRef = useRef(syncStates);
  syncStatesRef.current = syncStates;
  const [mailError, setMailError] = useState<string | null>(null);
  const inFlightBodiesRef = useRef<Map<string, Promise<BodyOutcome>>>(new Map());
  /** The DKIM key lookups of this session, kept so a sender's many messages cost one request. */
  const [lookupTxt] = useState(() => createTxtLookup());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [olderInFlight, setOlderInFlight] = useState<Readonly<Record<string, boolean>>>({});
  const [isLoadingOlderInList, setIsLoadingOlderInList] = useState(false);

  /**
   * One entry per mailbox with a sync running; `dirty` makes the loop go round again, as wide as
   * the widest request since the pass began, so every request is followed by a sync that started
   * after it. `isTorn`: a move or an older page landed between the pass's folders, which then
   * disagree about where mail is, so it goes round instead of landing.
   */
  const syncRunsRef = useRef<
    Map<string, { promise: Promise<void>; dirty: SyncScope | null; isTorn: boolean }>
  >(new Map());
  /**
   * Where this session's moves put each copy, keyed by the location it left, as the server said
   * (RFC 4315 `COPYUID`); null when it did not. A write addresses copies through it, because the
   * base names where they were until a sync catches up. Uids are never reused under one
   * UIDVALIDITY, so an entry stays true.
   */
  const movedRef = useRef<Map<string, Location | null>>(new Map());
  /** Per mailbox and thread, the last write's turn: the next resolves its uids once that one has answered. */
  const writeTurnsRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Counts sync starts; an acked op is retired by the first later one to land. */
  const syncSeqRef = useRef(0);
  /** When each address's last sync started, for the tab-return trigger (see `sync-staleness.ts`). */
  const syncStartedRef = useRef<Map<string, number>>(new Map());
  /** Keyed by mailbox and folder: two mailboxes over the same folder are one page. */
  const inFlightOlderRef = useRef<Map<string, Promise<void>>>(new Map());
  const liveManagerRef = useRef<LiveManager | null>(null);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  /** Mailboxes whose cached threads have been read into memory this unlock. */
  const hydratedRef = useRef<Set<string>>(new Set());
  const sessionGeneration = useRef(0);

  /**
   * Removals from the moment the vault delete is sent until their teardown ends. Adding the address
   * back waits for one: a PUT that overtook the delete would be erased by it, and a teardown that
   * outlived the PUT would clear the new address's cache.
   */
  const removalsRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Every piece of mail work in flight; the reload warning reads it (`relay/activity.ts`). */
  const [activity] = useState(createActivityTracker);
  const hasUnsavedWork = useSyncExternalStore(activity.subscribe, () =>
    activity.snapshot().some(isUnsavedWork),
  );
  // The browser's own "Leave site?" sheet, while a write someone asked for is still on its way.
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // `preventDefault()` is the standard (Chromium); the deprecated property is what some WebKit builds read.
      event.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [hasUnsavedWork]);
  /**
   * Replacements from the moment the edited record is stored until the old connection and cache are
   * gone. The address does not sync again before then, or its first sync would write into a cache
   * the teardown is about to clear.
   */
  const replacementsRef = useRef<Map<string, Promise<void>>>(new Map());
  /** An edit's vault write in flight: a removal of that address waits for it, so the delete lands last. */
  const editsRef = useRef<Map<string, Promise<void>>>(new Map());
  const recordsRef = useRef(records);
  recordsRef.current = records;
  /** The inbound records as last rendered, or as an edit or a removal has just left them. */
  const mailboxesRef = useRef<readonly InboundAddress[]>([]);
  /** Whether `mailbox` is still the record of its address: not edited, not removed. */
  const isCurrentMailbox = useCallback(
    (mailbox: InboundAddress) =>
      mailboxesRef.current.some(
        candidate =>
          candidate.address === mailbox.address && sameImap(candidate.imap, mailbox.imap),
      ),
    [],
  );

  /**
   * The IMAP runner of the session open now, taken where the work starts, before its first await,
   * as the generation is. Once that session has ended it refuses every task before reaching a
   * manager, so one person's mail never travels over the next session's connections.
   */
  const bindRunOn = useCallback((): RunOn => {
    const generation = sessionGeneration.current;
    /**
     * A task is made for one record. Once that address has been edited or removed it is refused
     * rather than run: `manager.run` logs in with whatever mailbox it is handed, so old credentials
     * would go back on the connection an edit just closed, and a draft or a Sent copy would land in
     * the old mailbox. A task submitted before the edit is not interrupted: it finishes on the
     * socket it started on (`live.ts`), which is how a send already past SMTP still files its copy.
     * One submitted after waits for the edit's teardown, then runs as the new record.
     */
    return mailbox => async task => {
      if (generation !== sessionGeneration.current || liveManagerRef.current === null) {
        return VAULT_LOCKED;
      }
      if (!isCurrentMailbox(mailbox)) return ADDRESS_CHANGED;
      const teardown = replacementsRef.current.get(mailbox.address);
      if (teardown !== undefined) {
        await teardown;
        if (generation !== sessionGeneration.current) return VAULT_LOCKED;
        if (!isCurrentMailbox(mailbox)) return ADDRESS_CHANGED;
      }
      const manager = liveManagerRef.current;
      if (manager === null) return VAULT_LOCKED;
      return manager.run(mailbox, task);
    };
  }, [isCurrentMailbox]);

  const {
    serverSearch,
    found,
    search,
    askAndWait: askServersAndWait,
    afterWrite: afterFoundWrite,
    forget: forgetFound,
  } = useServerSearch({ mailboxesRef, userIdRef, syncRunsRef, bindRunOn, activity });
  const followSearch = useCallback(
    (q: string | undefined) => {
      if (q === undefined) {
        search.stop();
        return;
      }
      if (search.query() !== q.trim()) search.now(q);
    },
    [search],
  );

  const storeAddress = useCallback(
    async (record: AddressRecord) => {
      if (isDemo()) return;
      // Unreachable while locked; refuse rather than hold an address that looks stored and is not.
      if (session === null) throw new Error("You're signed out; nothing can be stored.");
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
        throw new Error('You were signed out; nothing was stored.');
      }
      await storeAddress(record);
      // Stored in the vault the call began in, whose next unlock lists it. Shown in the session
      // after it, it would sync that person's mailbox over this one's connections.
      if (generation !== sessionGeneration.current) return;
      mailboxesRef.current = upsertRecord(recordsRef.current, record).filter(isInbound);
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
        if (session === null) throw new Error("You're signed out; nothing can be removed.");
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
          // An edit's write that is already on its way lands first, or it would bring the record back.
          const editing = editsRef.current.get(address);
          if (editing !== undefined) await editing;
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
          // A clear that fails is finished by the lock's, which empties every mailbox of this user.
          await createMailCache(userId, address)
            .clear()
            .catch(() => {});
          // The next session's state for an address of the same name is not this removal's to drop.
          if (generation !== sessionGeneration.current) return;
          setSyncStates(current => {
            const { [address]: _, ...rest } = current;
            return rest;
          });
        })().finally(settle);
      }
      // `isStale` reads the ref, so a sync of this address stops writing now, not at the next render.
      mailboxesRef.current = mailboxesRef.current.filter(mailbox => mailbox.address !== address);
      hydratedRef.current.delete(address);
      setRecords(current => current.filter(record => record.address !== address));
      forgetFound(address);
      setBaseByMailbox(current => {
        const { [address]: _, ...rest } = current;
        return rest;
      });
      setOps(current => current.filter(op => op.mailbox !== address));
      // All of them: a `mid/<Message-ID>` id carries no mailbox, and a body kept under one could
      // later be shown for a different message.
      setBodiesById({});
      setPreviews(current => withoutMailboxPreviews(current, address));
    },
    [session, forgetFound],
  );

  /**
   * The vault write is the commit point and a refusal changes nothing. After it the running app
   * uses the new record at once: a sync begun for the old one goes stale, and the slow half runs
   * off the caller, as a removal's does. The connection closes so the next task logs in with the
   * new credentials. A host or login that may name another mailbox also sends the old one's mail
   * off the screen and out of the cache, so it syncs fresh. The address syncs again only after.
   */
  const replaceAddress = useCallback(
    async (record: AddressRecord) => {
      const generation = sessionGeneration.current;
      const { address } = record;
      // A removal that has begun or finished owns the address: writing now would bring it back.
      if (
        removalsRef.current.has(address) ||
        !recordsRef.current.some(r => r.address === address)
      ) {
        throw new Error('That address has been removed; nothing was stored.');
      }
      const write = Promise.withResolvers<void>();
      editsRef.current.set(address, write.promise);
      try {
        await storeAddress(record);
      } finally {
        if (editsRef.current.get(address) === write.promise) editsRef.current.delete(address);
        write.resolve();
      }
      // Stored in the vault the call began in, whose next unlock lists it; nothing of it is shown
      // in the session after.
      if (generation !== sessionGeneration.current) return;
      const previous = recordsRef.current.find(candidate => candidate.address === address);
      // Removed while the vault wrote; the removal's teardown stands.
      if (previous === undefined) return;
      const swap = (current: readonly AddressRecord[]) =>
        current.map(candidate => (candidate.address === address ? record : candidate));
      if (sameImap(previous.imap, record.imap)) {
        setRecords(swap);
        return;
      }

      const isAnotherMailbox = mayBeAnotherMailbox(previous, record);
      const userId = userIdRef.current;
      const manager = liveManagerRef.current;
      const running = syncRunsRef.current.get(address)?.promise;
      const replacement = Promise.withResolvers<void>();
      replacementsRef.current.set(address, replacement.promise);
      // Read by `isStale`, so a sync of the old record stops writing now, not at the next render.
      mailboxesRef.current = swap(recordsRef.current).filter(isInbound);
      // The next request starts a run of its own, with the new record, instead of joining that one.
      syncRunsRef.current.delete(address);
      if (isAnotherMailbox) {
        forgetFound(address);
        hydratedRef.current.delete(address);
        for (const key of movedRef.current.keys()) {
          if (key.startsWith(`${address}/`)) movedRef.current.delete(key);
        }
        setBaseByMailbox(current => {
          const { [address]: _, ...rest } = current;
          return rest;
        });
        setOps(current => current.filter(op => op.mailbox !== address));
        // All of them, as a removal does: an id carries no mailbox.
        inFlightBodiesRef.current.clear();
        setBodiesById({});
        setPreviews(current => withoutMailboxPreviews(current, address));
      }
      setRecords(swap);

      void (async () => {
        await manager?.close(address);
        await running;
        if (isAnotherMailbox && userId !== null) {
          const { createMailCache } = await import('../threads/cache');
          // A clear that fails is finished by the lock's, which empties every mailbox of this user.
          await createMailCache(userId, address)
            .clear()
            .catch(() => {});
        }
        // The next session's state for an address of the same name is not this one's to drop.
        if (isAnotherMailbox && generation === sessionGeneration.current) {
          setSyncStates(current => {
            const { [address]: _, ...rest } = current;
            return rest;
          });
        }
      })().finally(() => {
        if (replacementsRef.current.get(address) === replacement.promise) {
          replacementsRef.current.delete(address);
        }
        replacement.resolve();
      });
    },
    [storeAddress, forgetFound],
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

  const identities = records;
  /** The inbound record an address has now: what a send already claimed files its copy through. */
  const currentMailbox = useCallback(
    (address: string) => mailboxesRef.current.find(mailbox => mailbox.address === address),
    [],
  );

  const mailboxes = useMemo(() => records.filter(isInbound), [records]);
  const ownedAddresses = useMemo(() => records.map(record => record.address), [records]);

  mailboxesRef.current = mailboxes;

  /** A write landed between a running sync's folders; see `isTorn`. */
  const tearRunningSync = useCallback((address: string) => {
    const running = syncRunsRef.current.get(address);
    if (running !== undefined) running.isTorn = true;
  }, []);

  const requestSync = useCallback(
    (mailbox: InboundAddress, scope: SyncScope = 'all'): Promise<void> => {
      const address = mailbox.address;
      const running = syncRunsRef.current.get(address);
      if (running !== undefined) {
        running.dirty = running.dirty === 'all' ? 'all' : scope;
        return running.promise;
      }

      const generation = sessionGeneration.current;
      const runOn = bindRunOn();
      const userId = userIdRef.current;
      if (userId === null) return Promise.resolve();
      const entry: { dirty: SyncScope | null; isTorn: boolean; promise: Promise<void> } = {
        dirty: scope,
        isTorn: false,
        promise: Promise.resolve(),
      };
      entry.promise = (async () => {
        try {
          // A replaced record's old connection and cache are gone before this address syncs again.
          await replacementsRef.current.get(address);
          const { createMailCache } = await import('../threads/cache');
          const cache = createMailCache(userId, address);
          const isStale = () =>
            generation !== sessionGeneration.current || !isCurrentMailbox(mailbox);
          // The next session's hydrated set is not this run's to mark.
          if (isStale()) return;
          // The cache is the list until the server answers.
          if (!hydratedRef.current.has(address)) {
            hydratedRef.current.add(address);
            const { cachedSummaries, cachedPreviews } = await import(
              '@yozz.app/mail/threads/hydrate'
            );
            const [cached, cachedText] = await Promise.all([
              cachedSummaries(cache),
              cachedPreviews(cache, address),
            ]);
            if (isStale()) return;
            if (Object.values(cached).some(folder => folder.summaries.length > 0)) {
              setBaseByMailbox(current => ({ ...current, [address]: cached }));
            }
            setPreviews(current => ({ ...current, ...cachedText }));
            // The rows above are only scheduled, and the import below starts fetching the TLS /
            // IMAP stack at once; one that arrived from the HTTP cache would run before the paint.
            await afterNextPaint();
            if (isStale()) return;
          }
          const { syncMailbox, prefetchBodies } = await import('@yozz.app/mail/threads/sync');
          /**
           * How the pass before this one in the loop ended. The next starts before React renders
           * what it set, so the refs still hold the state from before it.
           */
          let lastPass: {
            readonly status: MailboxSyncState['status'];
            readonly scope: SyncScope;
            readonly seq: number;
          } | null = null;
          do {
            // The first pass fetched the TLS stack, long enough for a lock to land under it; a later
            // one may belong to a record that has since been replaced, and would log in as it.
            if (isStale()) return;
            // Only a whole pass retires a write or mends a failed sync, so either asks for one.
            const lastStatus = lastPass?.status ?? syncStatesRef.current[address]?.status;
            const opsLeft =
              lastPass?.scope === 'all' && lastPass.status === 'synced'
                ? retireOps(opsRef.current, address, lastPass.seq)
                : opsRef.current;
            const passScope =
              entry.dirty === 'inbox' &&
              lastStatus === 'synced' &&
              !opsLeft.some(op => op.mailbox === address)
                ? 'inbox'
                : 'all';
            entry.dirty = null;
            entry.isTorn = false;
            syncSeqRef.current += 1;
            const seq = syncSeqRef.current;
            if (passScope === 'all') {
              syncStartedRef.current.set(address, Date.now());
              setSyncStates(current => ({ ...current, [address]: { status: 'syncing' } }));
            }
            // Each folder shows as it lands, the inbox first; pending ops stay laid over it until
            // the whole pass retires them below. A folder read after a write landed may disagree
            // with one read before it, so a torn pass shows no more of itself.
            const result = await syncMailbox(
              runOn(mailbox),
              cache,
              isStale,
              (folder, read) => {
                if (isStale() || entry.isTorn) return;
                setBaseByMailbox(current => ({
                  ...current,
                  [address]: { ...current[address], [folder]: read },
                }));
              },
              passScope,
            );
            if (generation !== sessionGeneration.current) return;
            // Its folders were read on either side of a write; the next pass lands instead.
            if (result.state.status === 'synced' && entry.isTorn) {
              entry.dirty = 'all';
              continue;
            }
            // A UIDVALIDITY reset dropped the cache; the threads on screen and the ops against them name invalid uids.
            if (result.state.status === 'failed' && result.state.invalidated) {
              setBaseByMailbox(current => ({ ...current, [address]: {} }));
              forgetFound(address);
              setPreviews(current => withoutMailboxPreviews(current, address));
              setOps(current => current.filter(op => op.mailbox !== address));
            }
            const { state } = result;
            lastPass = { status: state.status, scope: result.scope, seq };
            if (state.status === 'synced') {
              // The new mail an inbox pass read has landed through `onFolder`, and every other folder
              // stays as the last whole pass left it.
              if (result.scope === 'all') {
                setBaseByMailbox(current => ({ ...current, [address]: result.byFolder }));
                // This pass started after the acks it retires, on the same serial queue as their commands.
                setOps(current => retireOps(current, address, seq));
                // The server's flags just arrived; an earlier refused write is moot.
                setMailError(null);
              }
              void prefetchBodies(
                runOn(mailbox),
                cache,
                result.byFolder,
                MAX_CACHED_BODY_BYTES,
                30,
                lookupTxt,
                isStale,
                bodies => {
                  if (isStale()) return;
                  setPreviews(current => ({
                    ...current,
                    ...Object.fromEntries(
                      bodies.map(({ at, body }) => [
                        previewKey({ mailbox: address, ...at }),
                        body.paragraphs,
                      ]),
                    ),
                  }));
                },
              );
            }
            setSyncStates(current => {
              const before = current[address];
              if (
                result.scope === 'all' ||
                state.status !== 'synced' ||
                before?.status !== 'synced'
              ) {
                return { ...current, [address]: state };
              }
              // Every other folder is as complete as the last whole pass found it.
              const complete = [
                ...before.complete.filter(folder => folder !== 'inbox'),
                ...state.complete.filter(folder => folder === 'inbox'),
              ];
              return { ...current, [address]: { ...state, complete } };
            });
          } while (entry.dirty !== null);
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
    [bindRunOn, forgetFound, isCurrentMailbox, lookupTxt],
  );

  /** New mail is in the inbox, so a notice of it reads that folder alone. */
  const syncInbox = useCallback(
    (address: string) => {
      if (isDemo()) return;
      const mailbox = mailboxesRef.current.find(candidate => candidate.address === address);
      if (mailbox !== undefined) void requestSync(mailbox, 'inbox');
    },
    [requestSync],
  );
  const syncInboxRef = useRef(syncInbox);
  syncInboxRef.current = syncInbox;

  const sync = useCallback(
    async (address?: string): Promise<void> => {
      if (isDemo()) return;
      const currentMailboxes = mailboxesRef.current;
      if (address !== undefined) {
        const mailbox = currentMailboxes.find(candidate => candidate.address === address);
        if (mailbox !== undefined) {
          await requestSync(mailbox);
        }
        return;
      }
      await Promise.all(currentMailboxes.map(mailbox => requestSync(mailbox)));
    },
    [requestSync],
  );

  /** Read by the draft writes, which run outside a render. */
  const threadsRef = useRef<readonly ThreadState[]>([]);
  const { composer, shared, load, reset, vaultSent } = useComposerStore({
    session,
    identities,
    mailboxes,
    bindRunOn,
    currentMailbox,
    sync,
    threadsRef,
    baseByMailbox,
    demo,
    activity,
  });
  const { drafts } = shared;

  // Keyed on the store, not the session object: a mode switch in Settings hands out a new session
  // over the same store and user, and that must not restart the mail session or clear its cache.
  const store = session?.store ?? null;
  const files = session?.files ?? null;
  const userId = session?.userId ?? null;
  useEffect(() => {
    if (import.meta.env.DEV && isDemo()) {
      // Dynamic so the fixture module stays out of the production bundle; the `DEV` guard is what
      // lets Vite drop the branch.
      void import('../dev/fixtures').then(({ DEMO_ADDRESSES, DEMO_WINDOWS, THREADS }) => {
        setRecords(DEMO_ADDRESSES);
        setDemoThreads(THREADS);
        setDemoWindows(DEMO_WINDOWS);
      });
      setRecordsError(null);
      return;
    }
    if (store === null || files === null || userId === null) return;
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
          onMailboxChanged: address => {
            if (!cancelled) syncInboxRef.current(address);
          },
          activity,
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
        // Read by the runner, which would otherwise refuse the resumed work this load starts.
        mailboxesRef.current = parsed.filter(isInbound);
        setRecords(parsed);
        await load({ store, files }, parsed, () => cancelled);
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
      syncStartedRef.current.clear();
      movedRef.current.clear();
      writeTurnsRef.current.clear();
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
      setBaseByMailbox({});
      search.stop();
      forgetFound();
      setBodiesById({});
      setPreviews({});
      setOps([]);
      setSyncStates({});
      setOlderInFlight({});
      reset(userId);
      setMailError(null);
      // Every toast reports on this session's mail, and one that waits to be read would wait for
      // whoever unlocks next.
      toast.close();
    };
  }, [store, files, userId, load, reset, activity, search.stop, forgetFound]);

  /** One mailbox's next window of a folder. A refused page reports like a refused flag write. */
  const loadOlderOn = useCallback(
    async (mailbox: InboundAddress, folder: Folder): Promise<void> => {
      const key = `${mailbox.address}/${folder}`;
      const inFlight = inFlightOlderRef.current.get(key);
      if (inFlight !== undefined) return inFlight;

      const generation = sessionGeneration.current;
      const runOn = bindRunOn();
      const userId = userIdRef.current;
      if (userId === null) return;
      const promise = (async () => {
        try {
          const [{ loadOlder: loadOlderPage }, { cachedSummaries }, { createMailCache }] =
            await Promise.all([
              import('@yozz.app/mail/threads/sync'),
              import('@yozz.app/mail/threads/hydrate'),
              import('../threads/cache'),
            ]);
          const cache = createMailCache(userId, mailbox.address);
          const isStale = () =>
            generation !== sessionGeneration.current || !isCurrentMailbox(mailbox);
          const res = await loadOlderPage(runOn(mailbox), cache.folder(folder), isStale);
          if (generation !== sessionGeneration.current) return;
          if (!res.ok) {
            setMailError(olderNotLoaded(res.error, mailbox));
            return;
          }
          tearRunningSync(mailbox.address);
          const summaries = await cachedSummaries(cache);
          if (generation !== sessionGeneration.current) return;
          // Flushed: a list paging across folders reads where this left it next.
          flushSync(() => {
            setBaseByMailbox(current => ({ ...current, [mailbox.address]: summaries }));
            setMailError(null);
            if (!res.value.complete) return;
            setSyncStates(current => {
              const state = current[mailbox.address];
              if (state?.status !== 'synced' || state.complete.includes(folder)) return current;
              return {
                ...current,
                [mailbox.address]: { ...state, complete: [...state.complete, folder] },
              };
            });
          });
        } catch (error) {
          if (generation !== sessionGeneration.current) return;
          setMailError(
            olderNotLoaded(
              { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
              mailbox,
            ),
          );
        }
      })().finally(() => {
        inFlightOlderRef.current.delete(key);
      });

      inFlightOlderRef.current.set(key, promise);
      return promise;
    },
    [bindRunOn, isCurrentMailbox, tearRunningSync],
  );

  const loadOlder = useCallback(
    async (view: ViewId): Promise<void> => {
      if (isDemo()) return;
      const folder = folderPaged(view);
      const targets = mailboxesShown(mailboxesRef.current, view);
      if (targets.length === 0) return;
      const generation = sessionGeneration.current;
      setOlderInFlight(current => ({ ...current, [view]: true }));
      try {
        await Promise.all(targets.map(mailbox => loadOlderOn(mailbox, folder)));
      } finally {
        // The next session may be paging the same view.
        if (generation === sessionGeneration.current) {
          setOlderInFlight(current => ({ ...current, [view]: false }));
        }
      }
    },
    [loadOlderOn],
  );

  const loadOlderInList = useCallback(
    async (query: string): Promise<void> => {
      // What a search named goes a page at a time, with nothing searched again.
      if (planOf(query.trim(), mailboxesRef.current) !== null) {
        setIsLoadingOlderInList(true);
        try {
          const page = await search.more();
          if (page === null) return;
          setMailError(page.result.ok ? null : olderNotLoaded(page.result.error, page.mailbox));
        } finally {
          setIsLoadingOlderInList(false);
        }
        return;
      }
      if (isDemo()) {
        setDemoWindows([]);
        return;
      }
      const generation = sessionGeneration.current;
      const listingNow = () =>
        listingOf({
          threads: threadsRef.current,
          view: 'unified',
          q: query,
          mailboxes: mailboxesRef.current,
          windows: windowsRef.current,
        });
      setIsLoadingOlderInList(true);
      try {
        const rowsBefore = listingNow().threads.length;
        for (let turn = 0; turn < OLDER_WINDOWS_PER_PAGE; turn += 1) {
          const { older } = listingNow();
          const mailbox = mailboxesRef.current.find(({ address }) => address === older?.mailbox);
          if (older === null || mailbox === undefined) return;
          await loadOlderOn(mailbox, older.folder);
          if (generation !== sessionGeneration.current) return;
          const after = listingNow();
          // A row gained, or nothing moved: a failure said so under the box, and asking again
          // this moment would only fail again.
          if (after.threads.length > rowsBefore) return;
          if (
            after.older?.mailbox === older.mailbox &&
            after.older.folder === older.folder &&
            after.older.reachedAt === older.reachedAt
          ) {
            return;
          }
        }
      } finally {
        if (generation === sessionGeneration.current) setIsLoadingOlderInList(false);
      }
    },
    [loadOlderOn, search],
  );

  // A rename or a new send-only identity must not reopen IMAP for every mailbox; credentials are in the key.
  const inboundKey = useMemo(
    () =>
      mailboxes
        .map(
          a => `${a.address}|${a.imap.host}|${a.imap.port}|${a.imap.username}|${a.imap.password}`,
        )
        .sort()
        .join('\n'),
    [mailboxes],
  );
  useEffect(() => {
    if (isDemo() || inboundKey === '') return;
    void sync();
    // `sync` reads mailboxes through a ref, so the key is the only real dependency.
  }, [inboundKey, sync]);

  useEffect(() => {
    if (isDemo()) return;
    // Coming back syncs only what has not synced in the last two minutes, so switching back often
    // does not resync every address each time. The other triggers are never throttled.
    const onVisibility = () => {
      if (document.hidden) return;
      const stale = staleMailboxes(mailboxesRef.current, syncStartedRef.current, Date.now());
      void Promise.all(stale.map(mailbox => requestSync(mailbox)));
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
  }, [sync, requestSync]);

  // The server's last word, grouped only when a sync, a page or a search changes it: a body, a
  // write or a draft is laid over the same grouping.
  const grouped = useMemo(
    () =>
      demo
        ? [...demoThreads, ...groupThreads({ byMailbox: {}, found })]
        : groupThreads({ byMailbox: baseByMailbox, found, vaultSent }),
    [demo, demoThreads, baseByMailbox, found, vaultSent],
  );
  const threads = useMemo(
    () =>
      demo
        ? grouped
        : layThreads(grouped, {
            bodies: bodiesById,
            previews,
            overlay: threads => applyOps(threads, ops),
            drafts,
          }),
    [demo, grouped, bodiesById, previews, ops, drafts],
  );

  threadsRef.current = threads;

  const windows = useMemo(
    () =>
      demo
        ? demoWindows
        : // What cannot offer older mail must not clip a list to where its cache stops.
          windowsOf(baseByMailbox, (mailbox, folder) => !hasOlderMail(syncStates[mailbox], folder)),
    [demo, demoWindows, baseByMailbox, syncStates],
  );
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  /**
   * The ops keep masking the base until a sync that started after this moment lands. None is asked
   * for: the next one that comes anyway retires them, and the ops show what the server now holds.
   */
  const acknowledge = useCallback((acked: readonly PendingOp[]) => {
    const retireAtSyncSeq = syncSeqRef.current + 1;
    const ids = new Set(acked.map(op => op.id));
    setOps(current =>
      current.map(candidate =>
        ids.has(candidate.id) ? { ...candidate, retireAtSyncSeq } : candidate,
      ),
    );
  }, []);

  /**
   * One optimistic write against the server's copies of many threads, answering which of them it
   * took. One op per thread and mailbox, all set at once; then per mailbox, one task whose IMAP
   * commands go one per source folder (`threads/sync.ts`), carrying every thread's uids, because a
   * uid only means something in its own mailbox and a server takes a set far better than a flood.
   * Writes to one thread in one mailbox take turns, so each addresses the copies where the one
   * before it left them. A refusal drops the ops it covers and lands in `mailError`, never in a sync
   * state; `onRefused` hears it once however many threads and mailboxes refused.
   */
  const runThreadOps = useCallback(
    (
      threadIds: readonly string[],
      change: PendingChange,
      pick: (folder: Folder) => boolean,
      command: (
        run: ReturnType<RunOn>,
        targets: readonly FlagTarget[],
        cache: MailCache,
      ) => Promise<Result<readonly MovedCopy[], MailConnectionFailure>>,
      onRefused?: OnRefused,
    ): ReadonlySet<string> => {
      const wanted = new Set(threadIds);
      const targeted = threads.filter(thread => wanted.has(thread.id));
      const opFor = (threadId: string, mailbox: string): PendingOp => ({
        id: crypto.randomUUID(),
        mailbox,
        threadId,
        change,
        retireAtSyncSeq: null,
      });
      if (isDemo()) {
        // Demo moves never touch the fixtures' locations, so the folders say who holds a copy.
        const demoOps = targeted.flatMap(thread =>
          Object.entries(thread.foldersByMailbox)
            .filter(([, folders]) => folders.some(pick))
            .map(([mailbox]) => opFor(thread.id, mailbox)),
        );
        setDemoThreads(current => applyOps(current, demoOps));
        return new Set(demoOps.map(op => op.threadId));
      }

      let isRefusalReported = false;
      const report = (reason: string) => {
        if (isRefusalReported) return;
        isRefusalReported = true;
        onRefused?.(reason);
      };
      const userId = userIdRef.current;
      // Per thread, each mailbox holding a copy this write changes, by the folders on screen, where
      // a pending move has already put its mailbox's copies. One op each, retired by that mailbox's
      // confirming sync.
      const work =
        userId === null
          ? []
          : targeted.flatMap(thread => {
              const serverCopies = thread.messages.flatMap(message =>
                (message.locations ?? []).filter(isServerCopy),
              );
              return mailboxesRef.current
                .filter(
                  mailbox =>
                    serverCopies.some(location => location.mailbox === mailbox.address) &&
                    (thread.foldersByMailbox[mailbox.address] ?? []).some(pick),
                )
                .map(mailbox => ({
                  mailbox,
                  op: opFor(thread.id, mailbox.address),
                  copies: serverCopies.filter(location => location.mailbox === mailbox.address),
                }));
            });
      const taken = new Set(work.map(({ op }) => op.threadId));
      // Nothing on the server to change, so no op: it would mask a base that is already right.
      if (taken.size < targeted.length) report('No copy of it is on a mail server YOZZ reads.');
      if (userId === null || work.length === 0) return taken;
      setOps(current => [...current, ...work.map(({ op }) => op)]);

      const generation = sessionGeneration.current;
      const runOn = bindRunOn();
      /** Whether this batch has put a refusal under the box, which its own successes keep. */
      let isRefusalShown = false;
      const refuse = (refused: readonly PendingOp[], reason: string) => {
        const ids = new Set(refused.map(op => op.id));
        setOps(current => current.filter(candidate => !ids.has(candidate.id)));
        isRefusalShown = true;
        setMailError(
          `${change.kind === 'move' ? 'thread not moved' : 'flag not saved'} · ${reason}`,
        );
        report(reason);
      };

      for (const [mailbox, items] of Map.groupBy(work, ({ mailbox }) => mailbox)) {
        const turnKeys = items.map(({ op }) => `${mailbox.address}\n${op.threadId}`);
        const previous = turnKeys.map(key => writeTurnsRef.current.get(key));
        const turn = (async () => {
          await Promise.all(previous);
          if (generation !== sessionGeneration.current) return;
          let failure: MailConnectionFailure;
          try {
            const { createMailCache } = await import('../threads/cache');
            const cache = createMailCache(userId, mailbox.address);
            const located = items.map(({ op, copies }) => {
              const now = copies.map(location => whereNow(movedRef.current, location));
              const here = now.filter(location => location !== null);
              return {
                op,
                isPlaced: here.length === now.length,
                picked: here.filter(location => pick(location.folder)),
              };
            });
            const folders = new Set(
              located.flatMap(({ picked }) => picked.map(({ folder }) => folder)),
            );
            const marks = new Map(
              await Promise.all(
                [...folders].map(
                  async folder => [folder, await cache.folder(folder).getSync()] as const,
                ),
              ),
            );
            if (generation !== sessionGeneration.current) return;
            // A move before this one left copies it cannot address yet (no UIDPLUS, a folder no sync
            // has read, or a refusal that left nothing where it looks); the sync it asks for can.
            const isReady = ({ isPlaced, picked }: (typeof located)[number]) =>
              isPlaced &&
              picked.length > 0 &&
              picked.every(({ folder }) => marks.get(folder) != null);
            const ready = located.filter(isReady);
            const waiting = located.filter(thread => !isReady(thread));
            if (waiting.length > 0) {
              refuse(
                waiting.map(({ op }) => op),
                MOVE_PENDING,
              );
              void requestSync(mailbox);
            }
            if (ready.length === 0) return;
            const targets = flagTargets(
              ready.flatMap(({ picked }) => picked),
              marks,
            );
            const res = await command(runOn(mailbox), targets, cache);
            // The session the command belonged to may have ended while the server answered.
            if (generation !== sessionGeneration.current) return;
            if (res.ok) {
              for (const { from, to } of res.value) {
                movedRef.current.set(
                  locationKey({ mailbox: mailbox.address, ...from }),
                  to === null ? null : { mailbox: mailbox.address, ...to },
                );
              }
              if (change.kind === 'move') tearRunningSync(mailbox.address);
              afterFoundWrite(mailbox.address, change, targets, res.value);
              acknowledge(ready.map(({ op }) => op));
              // Clears an earlier write's failure, never this batch's own: a refused thread or
              // mailbox would otherwise vanish from under the box as the rest lands.
              if (!isRefusalShown) setMailError(null);
              return;
            }
            failure = res.error;
          } catch (err) {
            if (generation !== sessionGeneration.current) return;
            failure = { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
          }
          // Every op of this mailbox still standing; one refused above as still confirming is gone.
          refuse(
            items.map(({ op }) => op),
            describeMailFailure(failure, mailbox.imap.host),
          );
          // A write over several folders or uid sets can be half done, and the refusal has just
          // unmasked the half that landed too: the sync says which half happened, one per mailbox
          // however many threads it carried. A half-done move must not land torn either. ponytail:
          // until it lands, a write queued right behind addresses the half that moved where it was,
          // which the server answers OK and does nothing. Un-park when seen.
          if (change.kind === 'move') tearRunningSync(mailbox.address);
          void requestSync(mailbox);
        })();
        for (const key of turnKeys) writeTurnsRef.current.set(key, turn);
      }
      return taken;
    },
    [acknowledge, afterFoundWrite, bindRunOn, requestSync, tearRunningSync, threads],
  );

  /** Sets a flag on every thread named; one already so needs no write and counts as taken. */
  const flagThreads = useCallback(
    (threadIds: readonly string[], key: 'isUnread' | 'isStarred', value: boolean) => {
      const wanted = new Set(threadIds);
      const named = threads.filter(thread => wanted.has(thread.id));
      const already = named.filter(thread => thread[key] === value).map(({ id }) => id);
      const changing = named.filter(thread => thread[key] !== value).map(({ id }) => id);
      const imapFlag = key === 'isUnread' ? '\\Seen' : '\\Flagged';
      const on = key === 'isUnread' ? !value : value;
      const taken = runThreadOps(
        changing,
        { kind: 'flag', key, value },
        () => true,
        async (run, targets, cache) => {
          const { setFlag } = await import('@yozz.app/mail/threads/sync');
          const res = await setFlag(run, cache, targets, imapFlag, on);
          // A flag write moves nothing.
          return res.ok ? { ok: true, value: [] } : res;
        },
      );
      return taken.union(new Set(already));
    },
    [runThreadOps, threads],
  );

  const loadBody = useCallback(
    (threadId: string, messageId: string): Promise<BodyOutcome> => {
      const failed = { status: 'failed' } as const;
      const thread = threads.find(t => t.id === threadId);
      const message = thread?.messages.find(m => m.id === messageId);
      if (message === undefined || thread === undefined) return Promise.resolve(failed);
      if (message.bodyStatus === undefined) {
        const {
          body,
          html,
          hasTextPart,
          htmlSaysMore,
          inlineImagesTruncated,
          attachments,
          senderCheck,
        } = message;
        return Promise.resolve({
          status: 'loaded',
          body,
          html,
          hasTextPart,
          htmlSaysMore,
          inlineImagesTruncated,
          attachments,
          senderCheck,
        });
      }
      // A second caller awaits the same fetch.
      const inFlight = inFlightBodiesRef.current.get(messageId);
      if (inFlight !== undefined) return inFlight;

      const userId = userIdRef.current;
      // Any copy will do for a body.
      const [copy] = message.locations ?? [];
      if (copy === undefined || userId === null) return Promise.resolve(failed);
      const { folder, uid, mailbox: mailboxAddress } = copy;
      const mailbox = mailboxesRef.current.find(a => a.address === mailboxAddress);
      if (mailbox === undefined) return Promise.resolve(failed);

      const setEntry = (entry: BodyEntry) =>
        setBodiesById(current => ({ ...current, [messageId]: entry }));
      /** The entry this fetch set, so retiring it never undoes a newer fetch's. */
      const loadingEntry: BodyEntry = { status: 'loading' };
      const generation = sessionGeneration.current;
      // What was fetched belongs to this record's mailbox: an edit that may name another one
      // clears the bodies, and a late answer must not fill them again under an id that carries no mailbox.
      const isStale = () => generation !== sessionGeneration.current || !isCurrentMailbox(mailbox);
      /**
       * Retires this fetch if its record has moved on. The body goes back to `pending`, which is
       * what loads it again with the current credentials: left `loading`, a password or port edit
       * (which keeps the bodies) would leave the spinner up for ever, since only `pending` is fetched
       * and only `failed` offers Retry.
       */
      const isRetired = () => {
        if (!isStale()) return false;
        if (generation === sessionGeneration.current) {
          setBodiesById(current => {
            if (current[messageId] !== loadingEntry) return current;
            const { [messageId]: _, ...rest } = current;
            return rest;
          });
        }
        return true;
      };
      const runOn = bindRunOn();
      const promise = (async (): Promise<BodyOutcome> => {
        try {
          const [{ fetchBodyAt }, { createMailCache }] = await Promise.all([
            import('@yozz.app/mail/threads/bodies'),
            import('../threads/cache'),
          ]);
          const cache = createMailCache(userId, mailboxAddress).folder(folder);
          const cached = await cache.getBody(uid);
          if (isRetired()) return failed;
          const fetchFresh = () => {
            // Only the network says "Loading…": a body on the device replaces `pending` directly.
            setEntry(loadingEntry);
            // Refused when the copy's folder was renumbered: a stale uid would fetch whatever now
            // holds that number. Caches the body when it is small enough.
            return fetchBodyAt(runOn(mailbox), cache, copy, message.rawSize, lookupTxt, isStale);
          };
          const res = cached !== null ? { ok: true as const, value: cached } : await fetchFresh();
          if (isRetired()) return failed;
          if (!res.ok) {
            setEntry(failed);
            setMailError(
              `message not loaded · ${describeMailFailure(res.error, mailbox.imap.host)}`,
            );
            return failed;
          }
          const loaded: BodyOutcome = {
            status: 'loaded',
            body: res.value.paragraphs,
            html: res.value.html,
            hasTextPart: res.value.hasTextPart,
            htmlSaysMore: res.value.htmlSaysMore,
            inlineImagesTruncated: res.value.inlineImagesTruncated,
            attachments: res.value.attachments,
            senderCheck: senderCheckOf(res.value.dkim, message.fromAddress),
          };
          setEntry(loaded);
          setMailError(null);
          return loaded;
        } catch (err) {
          if (isRetired()) return failed;
          setEntry(failed);
          setMailError(
            `message not loaded · ${describeMailFailure(
              { kind: 'error', detail: err instanceof Error ? err.message : String(err) },
              mailbox.imap.host,
            )}`,
          );
          return failed;
        }
      })();
      inFlightBodiesRef.current.set(messageId, promise);
      // By identity: an edit may have cleared this fetch's slot for a newer one.
      void promise.finally(() => {
        if (inFlightBodiesRef.current.get(messageId) === promise) {
          inFlightBodiesRef.current.delete(messageId);
        }
      });
      return promise;
    },
    [bindRunOn, isCurrentMailbox, lookupTxt, threads],
  );

  const markRead = useCallback(
    (threadId: string) => flagThreads([threadId], 'isUnread', false).has(threadId),
    [flagThreads],
  );

  const markUnread = useCallback(
    (threadId: string) => flagThreads([threadId], 'isUnread', true).has(threadId),
    [flagThreads],
  );

  const toggleStar = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      return flagThreads([threadId], 'isStarred', !thread.isStarred).has(threadId);
    },
    [flagThreads, threads],
  );

  /**
   * One optimistic folder move of many threads: `UID MOVE` per mailbox and source folder. One MOVE
   * per mailbox cannot be atomic across them, so a refusal asks for the sync that says which half
   * happened.
   */
  const moveThreads = useCallback(
    (threadIds: readonly string[], to: MoveTarget, onRefused?: OnRefused) => {
      const sources = MOVE_SOURCES[to];
      return runThreadOps(
        threadIds,
        { kind: 'move', to },
        // Only the copies this move consumes, in every mailbox that holds one.
        folder => sources.includes(folder),
        async (run, targets) => {
          const { moveMessages } = await import('@yozz.app/mail/threads/sync');
          return moveMessages(run, targets, to);
        },
        onRefused,
      );
    },
    [runThreadOps],
  );

  const toggleArchive = useCallback(
    (threadId: string, onRefused?: OnRefused) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      const to = isArchived(thread) ? 'inbox' : 'archive';
      return moveThreads([threadId], to, onRefused).has(threadId);
    },
    [moveThreads, threads],
  );

  const trashThread = useCallback(
    (threadId: string, onRefused?: OnRefused) =>
      moveThreads([threadId], 'trash', onRefused).has(threadId),
    [moveThreads],
  );

  const restoreThread = useCallback(
    (threadId: string, onRefused?: OnRefused) =>
      moveThreads([threadId], 'inbox', onRefused).has(threadId),
    [moveThreads],
  );

  const value = useMemo<MailContextValue>(
    () => ({
      mailboxes,
      identities,
      ownedAddresses,
      threads,
      ...shared,
      isDemo: demo,
      recordsError,
      mailError,
      syncStates,
      sync,
      loadOlder,
      isLoadingOlder: view => olderInFlight[view] === true,
      windows,
      loadOlderInList,
      isLoadingOlderInList,
      serverSearch,
      search,
      followSearch,
      askServersAndWait,
      putAddress,
      replaceAddress,
      removeAddress,
      setSenderName,
      activity,
      markRead,
      markUnread,
      toggleStar,
      loadBody,
      toggleArchive,
      trashThread,
      restoreThread,
      moveThreads,
      flagThreads,
    }),
    [
      mailboxes,
      identities,
      ownedAddresses,
      threads,
      demo,
      recordsError,
      mailError,
      syncStates,
      sync,
      loadOlder,
      olderInFlight,
      windows,
      loadOlderInList,
      isLoadingOlderInList,
      serverSearch,
      search,
      followSearch,
      askServersAndWait,
      putAddress,
      replaceAddress,
      removeAddress,
      setSenderName,
      activity,
      markRead,
      markUnread,
      toggleStar,
      loadBody,
      toggleArchive,
      trashThread,
      restoreThread,
      moveThreads,
      flagThreads,
      shared,
    ],
  );

  return (
    <MailContext value={value}>
      <ComposerContext value={composer}>{children}</ComposerContext>
    </MailContext>
  );
};

export const useMail = () => {
  const value = use(MailContext);
  if (value === null) throw new Error('useMail must be used inside <MailProvider>');
  return value;
};

/** The open draft: only the composer reads it, so a keystroke re-renders nothing else. */
export const useComposer = () => {
  const value = use(ComposerContext);
  if (value === null) throw new Error('useComposer must be used inside <MailProvider>');
  return value;
};
