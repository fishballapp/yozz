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
import { z } from 'zod';
import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  isInbound,
  parseAddressRecord,
} from '../lib/addresses';
import { isDemo } from '../lib/chrome';
import type { ComposeIntent } from '../lib/compose';
import { clearDraft, loadDraft, saveDraft } from '../lib/draft-store';
import {
  type Attachment,
  FOLDERS,
  type Folder,
  isArchived,
  isTrashed,
  type Message,
  parseThreadId,
  type Thread,
} from '../lib/thread';
import type { MailConnectionFailure, Result } from '../mail/connection';
import type { LiveManager, LiveState, LiveTask } from '../mail/live';
import type { AccountSyncState } from '../mail/sync';
import { vaultErrorMessage } from '../vault/screen-policy';
import { useVault } from '../vault/session';

/**
 * The whole app's mutable mail state. Addresses are vault records (or demo fixtures). Threads are
 * the union of each inbound address's synced envelopes, held in memory only: a lock drops them,
 * and nothing persists between reloads. `mail/` is reached through dynamic imports so the TLS
 * stack and the root bundle stay out of the entry chunk.
 */

export type { AccountSyncState, MailConnectionFailure };

/** A parsed body (attachment bytes included) is cached only when the raw message was under this. */
// ponytail: one ceiling; attachments-without-bytes would let bigger mail cache too.
const MAX_CACHED_BODY_BYTES = 1024 * 1024;

/** One sentence for a failed connection, the same whether it happened on Connect or on a sync. */
export const describeMailFailure = (failure: MailConnectionFailure, host: string): string => {
  switch (failure.kind) {
    case 'relay':
      return `Could not reach the relay: ${failure.detail}`;
    case 'error':
      return failure.detail;
    case 'tls':
      return `Secure connection to ${host} failed: ${failure.detail}`;
    case 'pin-mismatch':
      return `${failure.peer} presented a key YOZZ has not seen from it before. If you expect the server to have been re-keyed, forget its pinned key under Settings → Server keys and retry.`;
    case 'auth':
      return `${host} rejected the username or password`;
    case 'smtp': {
      const { reason } = failure;
      const text =
        reason.kind === 'reply'
          ? `${reason.code} ${reason.text}`
          : reason.kind === 'protocol' || reason.kind === 'unsupported'
            ? reason.detail
            : reason.kind;
      return `${host}: ${text}`;
    }
    case 'imap':
      return `${host}: ${
        failure.reason.kind === 'no' ||
        failure.reason.kind === 'bad' ||
        failure.reason.kind === 'bye'
          ? failure.reason.text
          : failure.reason.kind
      }`;
  }
};

/**
 * A thread plus the folders its messages sit in, derived by `threadsFromSummaries`; `isArchived`
 * and `isTrashed` are questions about that array, and an optimistic move rewrites it to where the
 * messages are going until the next sync says otherwise.
 */
export type ThreadState = Thread & { folders: readonly Folder[] };

/**
 * Every destination the rail can point at. Address-first: the accounts come before the views.
 *
 * A mailbox id is a URL segment, and the URL is a boundary like any other — the id can arrive from
 * a bookmark, a typo or a pasted address. Views are a closed set; an address is any email string,
 * and an address that is not connected is an in-pane state rather than a 404.
 */
const viewIdSchema = z.enum(['unified', 'starred', 'archive', 'sent', 'trash']);
type ViewId = z.infer<typeof viewIdSchema>;

export const isViewId = (value: string): value is ViewId => viewIdSchema.safeParse(value).success;

export const mailboxIdSchema = z.union([viewIdSchema, z.string().email()]);

export type MailboxId = z.infer<typeof mailboxIdSchema>;

/**
 * A recipient field is free text, so anything a person types between addresses separates them:
 * commas, semicolons and whitespace alike. The same reading for To, Cc and Bcc.
 */
const addressList = (value: string): readonly string[] =>
  value
    .split(/[,;\s]+/)
    .map(address => address.trim())
    .filter(address => address !== '');

export type ComposeDraft = {
  /**
   * Whether this draft opened with a quoted original in it. Recorded at open rather than derived
   * from the body, because the body changes as you type and anything keyed on it fires again
   * mid-sentence.
   */
  startedAsReply: boolean;
  /** The address to send as — the address is the identity id. */
  identityId: string;
  to: string;
  /** Carbon copies. Free text like `to`, split the same way. */
  cc: string;
  /**
   * Blind copies. Free text like `to` — and it reaches the envelope only, so no recipient
   * ever learns the list (`buildMessage` has no way to write a `Bcc` header).
   */
  bcc: string;
  subject: string;
  /** Markdown source. Rich text is deliberately out of scope for v1. */
  body: string;
  /** The Message-ID a reply answers; absent on a new message or a forward. */
  inReplyTo?: string;
  /** Picker files with their bytes read, or a forwarded message's; sent as `multipart/mixed`. */
  attachments: Attachment[];
};

type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

type MailContextValue = {
  accounts: readonly InboundAddress[];
  identities: readonly AddressRecord[];
  /** Every address you own, inbound or send-only — what makes a message "arrived" rather than sent. */
  ownedAddresses: readonly string[];
  threads: readonly ThreadState[];
  draft: ComposeDraft | null;
  isDemo: boolean;
  recordsError: string | null;
  /** The last refused read/star write or body fetch, in one sentence; cleared by the next one that works. */
  flagError: string | null;
  /** A send whose Sent-folder copy did not store; cleared by the next send that does. */
  sentCopyError: string | null;
  syncStates: Readonly<Record<string, AccountSyncState>>;
  liveStates: Readonly<Record<string, LiveState>>;
  sync: (address?: string) => Promise<void>;
  /**
   * Pages one window further back through the folder this mailbox lists, on every account it
   * shows. Idempotent and coalesced per account and folder, so a second click while the first is
   * in flight joins it rather than fetching the same window twice.
   */
  loadOlder: (mailbox: MailboxId) => Promise<void>;
  /** Whether that mailbox's page is in flight — what the foot control says while it waits. */
  isLoadingOlder: (mailbox: MailboxId) => boolean;
  /**
   * Opens, replaces or clears the draft. It does NOT decide whether the composer is on screen —
   * `?compose=` does (see `lib/compose.ts`), and this follows it. Anything that wants to start a
   * message navigates; nothing calls this directly except that sync. A draft stored on the device
   * for the same intent wins over the seed (`lib/draft-store.ts`), which is what survives a reload.
   */
  seedDraft: (
    intent: ComposeIntent | undefined,
    seed: Partial<ComposeDraft>,
  ) => ComposeDraft | null;
  updateDraft: (changes: Partial<ComposeDraft>) => void;
  /**
   * Sends the draft as its identity over that address's SMTP. Resolves once the server has
   * accepted the message; the draft is cleared only then, so a refusal leaves it to edit.
   */
  send: () => Promise<Result<void, MailConnectionFailure>>;
  markRead: (threadId: string) => void;
  /** Puts the whole thread back to unread; the reader closes with it, or opening would undo it. */
  markUnread: (threadId: string) => void;
  toggleStar: (threadId: string) => void;
  /** Fetches a message's body if it has not been, or failed. A no-op while it is loading. */
  loadBody: (threadId: string, messageId: string) => void;
  toggleArchive: (threadId: string) => void;
  /** Moves the whole conversation to Trash, your own sent copies included, as in Gmail. */
  trashThread: (threadId: string) => void;
  /** Brings a thread back to the inbox from Trash or Archive. */
  restoreThread: (threadId: string) => void;
  putAddress: (record: AddressRecord) => Promise<void>;
  removeAddress: (address: string) => Promise<void>;
  /** Sets or clears the From display name; an empty string clears it. */
  setSenderName: (address: string, senderName: string) => Promise<void>;
  attach: (attachments: readonly Attachment[]) => void;
  detach: (name: string) => void;
};

const MailContext = createContext<MailContextValue | null>(null);

/** Where a move can send a thread. Sent is not one: nothing moves mail INTO the Sent folder. */
type MoveTarget = 'inbox' | 'archive' | 'trash';

/**
 * Which folders a move empties into its destination. Archiving takes the inbox only, so the Sent
 * copies of the conversation stay where they are; the bin takes everything, because deleting half
 * a conversation is not what "delete" means to anyone.
 */
const MOVE_SOURCES: Record<MoveTarget, readonly Folder[]> = {
  archive: ['inbox'],
  trash: ['inbox', 'sent', 'archive'],
  inbox: ['archive', 'trash'],
};

/**
 * Threads rebuilt from summaries, carrying over any body already fetched. A summary holds flags
 * and envelope and no body, so without this a sync or a page of older mail blanks the message
 * being read — and the attachment bytes with it.
 */
const withFetchedBodies = (
  previous: readonly ThreadState[],
  fresh: readonly ThreadState[],
): readonly ThreadState[] => {
  const held = new Map(previous.map(thread => [thread.id, thread]));
  return fresh.map(thread => {
    const before = held.get(thread.id);
    if (before === undefined) return thread;
    return {
      ...thread,
      messages: thread.messages.map(message => {
        const kept = before.messages.find(m => m.id === message.id);
        return kept === undefined || kept.bodyStatus === 'pending'
          ? message
          : {
              ...message,
              body: kept.body,
              html: kept.html,
              hasTextPart: kept.hasTextPart,
              inlineImagesTruncated: kept.inlineImagesTruncated,
              attachments: kept.attachments,
              bodyStatus: kept.bodyStatus,
            };
      }),
    };
  });
};

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
  const [threadsByAccount, setThreadsByAccount] = useState<
    Readonly<Record<string, readonly ThreadState[]>>
  >({});
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, AccountSyncState>>>({});
  const [liveStates, setLiveStates] = useState<Readonly<Record<string, LiveState>>>({});
  const [flagError, setFlagError] = useState<string | null>(null);
  const [sentCopyError, setSentCopyError] = useState<string | null>(null);
  const inFlightBodiesRef = useRef<Set<string>>(new Set());
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const draftRef = useRef<ComposeDraft | null>(null);
  draftRef.current = draft;
  /** The intent the open draft belongs to; what the stored copy is filed under. */
  const draftIntentRef = useRef<ComposeIntent | undefined>(undefined);

  const [olderInFlight, setOlderInFlight] = useState<Readonly<Record<string, boolean>>>({});

  const inFlightSyncsRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Keyed by account and folder: two mailboxes over the same folder are one page. */
  const inFlightOlderRef = useRef<Map<string, Promise<void>>>(new Map());
  const liveManagerRef = useRef<LiveManager | null>(null);
  const syncRef = useRef<(address?: string) => Promise<void>>(async () => {});
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  // The userId of the session that was last unlocked, kept across the lock so the cleanup below can
  // clear its cache. Set only while unlocked, read only after a lock.
  const lastUserIdRef = useRef<string | null>(null);
  /** Accounts whose cached threads have been read into memory this unlock. */
  const hydratedRef = useRef<Set<string>>(new Set());
  /** Completed syncs per account; a flag revert is skipped once a newer sync has landed. */
  const syncCountRef = useRef<Map<string, number>>(new Map());
  const sessionGeneration = useRef(0);

  useEffect(() => {
    if (import.meta.env.DEV && isDemo()) {
      // Dynamic so the fixture module stays out of the production bundle; the `DEV` guard is
      // what lets Vite drop this branch, `isDemo()` alone is a runtime check it cannot see through.
      void import('../data/mail').then(({ DEMO_ADDRESSES, THREADS }) => {
        setRecords(DEMO_ADDRESSES);
        setDemoThreads(THREADS.map(thread => ({ ...thread, folders: ['inbox'] as const })));
      });
      setRecordsError(null);
      return;
    }
    if (session === null) {
      // A lock drops every decrypted thing, envelopes included; a sync still in flight from
      // before the lock belongs to a session that no longer exists. Bumping the generation FIRST
      // is the fence: an in-flight syncAccount checks it (via isStale) before it writes, so the
      // cache clear below cannot race a late write back in.
      sessionGeneration.current += 1;
      // Otherwise the next unlock's sync is handed the old in-flight promise and sets nothing.
      inFlightSyncsRef.current.clear();
      inFlightOlderRef.current.clear();
      hydratedRef.current.clear();
      const manager = liveManagerRef.current;
      liveManagerRef.current = null;
      const lockedUserId = lastUserIdRef.current;
      lastUserIdRef.current = null;
      void (async () => {
        // The running task finishes before the clear: a sync or prefetch that passed its last
        // isStale check could otherwise write plaintext into a cache that was just emptied.
        if (manager !== null) await manager.closeAll();
        if (lockedUserId === null) return;
        const { clearMailCache } = await import('../mail/cache');
        await clearMailCache(lockedUserId).catch(() => {});
      })();
      setRecords([]);
      setRecordsError(null);
      setThreadsByAccount({});
      setSyncStates({});
      setLiveStates({});
      setOlderInFlight({});
      // An open draft is this user's plaintext too; the next unlock may be someone else's, and
      // the provider outlives the session.
      setDraft(null);
      if (lockedUserId !== null) clearDraft(lockedUserId);
      setFlagError(null);
      return;
    }
    lastUserIdRef.current = session.userId;
    let cancelled = false;
    setRecordsError(null);
    void (async () => {
      const [{ createLiveManager }, { connectImap }] = await Promise.all([
        import('../mail/live'),
        import('../mail/connection'),
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
        const listed = await session.store.list(ADDRESS_RECORD_TYPE);
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
      } catch (err) {
        if (!cancelled) setRecordsError(vaultErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  /** `onlyIf` guards a revert: it is skipped when the thread no longer holds the value being undone. */
  const patch = useCallback(
    (
      threadId: string,
      changes: Partial<ThreadState>,
      onlyIf: (thread: ThreadState) => boolean = () => true,
    ) => {
      if (isDemo()) {
        setDemoThreads(current =>
          current.map(thread =>
            thread.id === threadId && onlyIf(thread) ? { ...thread, ...changes } : thread,
          ),
        );
        return;
      }
      setThreadsByAccount(current => {
        let touched = false;
        const next: Record<string, readonly ThreadState[]> = {};
        for (const [address, accThreads] of Object.entries(current)) {
          const updated = accThreads.map(thread => {
            if (thread.id === threadId && onlyIf(thread)) {
              touched = true;
              return { ...thread, ...changes };
            }
            return thread;
          });
          next[address] = updated;
        }
        return touched ? next : current;
      });
    },
    [],
  );

  const putAddress = useCallback(
    async (record: AddressRecord) => {
      if (!isDemo()) {
        // The gate keeps this unreachable while locked; if it ever is reached, refuse rather than
        // keep an address in memory that looks stored and is not.
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
        // Let an in-flight sync of this account finish before clearing: it checks isStale (the
        // account is now gone from records) and skips its own cache write, so the clear lands last.
        await inFlightSyncsRef.current.get(address);
        const { createMailCache } = await import('../mail/cache');
        await createMailCache(session.userId, address).clear();
      }
      setRecords(current => current.filter(record => record.address !== address));
      setThreadsByAccount(current => {
        const { [address]: _, ...rest } = current;
        return rest;
      });
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

  // A pasted `?compose=` URL seeds the draft before the vault has answered, so the draft can
  // hold no sender. Heal it once identities exist (or the chosen one was removed) without
  // touching anything else the user typed.
  useEffect(() => {
    setDraft(current => {
      if (current === null) return current;
      if (identities.some(identity => identity.address === current.identityId)) return current;
      const fallback = identities[0]?.address ?? '';
      return fallback === current.identityId ? current : { ...current, identityId: fallback };
    });
  }, [identities]);
  const accounts = useMemo(() => records.filter(isInbound), [records]);
  const ownedAddresses = useMemo(() => records.map(record => record.address), [records]);

  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const syncOneAccount = useCallback(
    async (account: InboundAddress): Promise<void> => {
      const address = account.address;
      const inFlight = inFlightSyncsRef.current.get(address);
      if (inFlight !== undefined) {
        return inFlight;
      }

      const generation = sessionGeneration.current;
      const userId = userIdRef.current;
      if (userId === null) return;
      const promise = (async () => {
        setSyncStates(current => ({ ...current, [address]: { status: 'syncing' } }));
        try {
          const [{ syncAccount, cachedThreads, prefetchBodies }, { createMailCache }] =
            await Promise.all([import('../mail/sync'), import('../mail/cache')]);
          const cache = createMailCache(userId, address);
          // The cache is the list until the server answers: what the last unlock left behind.
          if (!hydratedRef.current.has(address)) {
            hydratedRef.current.add(address);
            const cached = await cachedThreads(cache, address);
            if (generation !== sessionGeneration.current) return;
            if (cached.length > 0) {
              setThreadsByAccount(current => ({ ...current, [address]: cached }));
            }
          }
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === address);
          const result = await syncAccount(runOn(account), cache, account, isStale);
          if (generation !== sessionGeneration.current) return;
          // A UIDVALIDITY reset dropped the cache; the threads still on screen name invalid uids, so
          // clear them now rather than leave them openable until a later sync lands.
          if (result.state.status === 'failed' && result.state.invalidated) {
            setThreadsByAccount(current => ({ ...current, [address]: [] }));
          }
          if (result.state.status === 'synced') {
            setThreadsByAccount(current => ({
              ...current,
              [address]: withFetchedBodies(current[address] ?? [], result.threads),
            }));
            syncCountRef.current.set(address, (syncCountRef.current.get(address) ?? 0) + 1);
            // The server's flags just arrived; an earlier refused write is moot.
            setFlagError(null);
            prefetchBodies(
              runOn(account),
              cache,
              result.byFolder,
              MAX_CACHED_BODY_BYTES,
              30,
              isStale,
            );
          }
          setSyncStates(current => ({ ...current, [address]: result.state }));
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
        }
      })().finally(() => {
        inFlightSyncsRef.current.delete(address);
      });

      inFlightSyncsRef.current.set(address, promise);
      return promise;
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
          await syncOneAccount(account);
        }
        return;
      }
      await Promise.all(currentAccounts.map(account => syncOneAccount(account)));
    },
    [syncOneAccount],
  );
  syncRef.current = sync;

  /**
   * One account's next window of a folder: load it, re-thread that account from the cache, and
   * record the folder as complete once its start is in. A refused page reports like a refused
   * flag write — the threads on screen are still good, only one FETCH was not.
   */
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
          const [{ loadOlder: loadOlderPage, cachedThreads }, { createMailCache }] =
            await Promise.all([import('../mail/sync'), import('../mail/cache')]);
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
          const threads = await cachedThreads(cache, account.address);
          if (generation !== sessionGeneration.current) return;
          setThreadsByAccount(current => ({
            ...current,
            [account.address]: withFetchedBodies(current[account.address] ?? [], threads),
          }));
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

  // What a sync depends on, as a string, so a rename or a new send-only identity does not reopen
  // IMAP for every account. Credentials are in the key: editing them should refetch.
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

  const threads = useMemo(() => {
    if (demo) return demoThreads;
    return Object.values(threadsByAccount).flat();
  }, [demo, demoThreads, threadsByAccount]);

  /**
   * A flag write is optimistic: the thread changes now and IMAP hears about it after. A refused
   * write reverts the thread, but only if nothing else changed it meanwhile: a sync that replaced
   * the thread in between has the server's answer, which beats the revert. The failure lands in
   * `flagError`, not the account's sync state: the threads are still good, only one STORE was not.
   */
  const setThreadFlag = useCallback(
    (threadId: string, key: 'isUnread' | 'isStarred', value: boolean) => {
      const previous = !value;
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return;
      patch(threadId, { [key]: value });
      if (isDemo()) return;

      const accountAddress = thread.accountId;
      // A thread's flag is the union of its messages', so the write goes to every one of them —
      // grouped by folder, since a uid only means something inside its own mailbox.
      const uidsByFolder = Map.groupBy(
        thread.messages.flatMap(message => parseThreadId(message.id) ?? []),
        parsed => parsed.folder,
      );
      const account = accountsRef.current.find(a => a.address === accountAddress);
      const userId = userIdRef.current;
      if (account === undefined || userId === null || uidsByFolder.size === 0) return;

      const imapFlag = key === 'isUnread' ? '\\Seen' : '\\Flagged';
      const on = key === 'isUnread' ? !value : value;
      const syncsBefore = syncCountRef.current.get(accountAddress) ?? 0;
      void (async () => {
        let failure: MailConnectionFailure;
        try {
          const [{ setFlag }, { createMailCache }] = await Promise.all([
            import('../mail/sync'),
            import('../mail/cache'),
          ]);
          const cache = createMailCache(userId, accountAddress);
          const targets = await Promise.all(
            [...uidsByFolder].map(async ([folder, parsed]) => {
              const mark = await cache.folder(folder).getSync();
              if (mark === null) throw new Error(`${folder} has not synced`);
              return { mailbox: mark.name, uids: parsed.map(({ uid }) => uid) };
            }),
          );
          const res = await setFlag(runOn(account), targets, imapFlag, on);
          if (res.ok) {
            setFlagError(null);
            return;
          }
          failure = res.error;
        } catch (err) {
          failure = { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
        }
        // A sync that landed meanwhile carries the server's answer and beats the revert, even
        // when it happens to agree with the optimistic value.
        const syncedSince = (syncCountRef.current.get(accountAddress) ?? 0) !== syncsBefore;
        if (!syncedSince) patch(threadId, { [key]: previous }, thread => thread[key] === value);
        setFlagError(describeMailFailure(failure, account.imap.host));
      })();
    },
    [patch, runOn, threads],
  );

  const loadBody = useCallback(
    (threadId: string, messageId: string) => {
      const thread = threads.find(t => t.id === threadId);
      const message = thread?.messages.find(m => m.id === messageId);
      if (message === undefined || message.bodyStatus === undefined) return;
      // `bodyStatus` is state a sync can rewrite mid-fetch; the ref is what actually says "in
      // flight", like `inFlightSyncsRef` for syncs.
      if (inFlightBodiesRef.current.has(messageId)) return;

      const parsed = parseThreadId(messageId);
      const userId = userIdRef.current;
      if (parsed === null || userId === null) return;
      const { accountAddress, folder, uid } = parsed;
      const account = accountsRef.current.find(a => a.address === accountAddress);
      if (account === undefined) return;

      const setMessage = (changes: Partial<Message>) =>
        setThreadsByAccount(current => {
          const accThreads = current[accountAddress];
          if (accThreads === undefined) return current;
          return {
            ...current,
            [accountAddress]: accThreads.map(t =>
              t.id === threadId
                ? {
                    ...t,
                    messages: t.messages.map(m => (m.id === messageId ? { ...m, ...changes } : m)),
                  }
                : t,
            ),
          };
        });

      setMessage({ bodyStatus: 'loading' });
      const generation = sessionGeneration.current;
      inFlightBodiesRef.current.add(messageId);
      void (async () => {
        try {
          const [{ fetchBody }, { createMailCache }] = await Promise.all([
            import('../mail/bodies'),
            import('../mail/cache'),
          ]);
          const cache = createMailCache(userId, accountAddress).folder(folder);
          const cached = await cache.getBody(uid);
          const fetchFresh = async () => {
            const mark = await cache.getSync();
            if (mark === null) throw new Error(`${folder} has not synced`);
            return fetchBody(runOn(account), mark.name, uid, message.rawSize);
          };
          const res = cached !== null ? { ok: true as const, value: cached } : await fetchFresh();
          if (generation !== sessionGeneration.current) return;
          if (res.ok) {
            if (
              cached === null &&
              (message.rawSize ?? Number.POSITIVE_INFINITY) <= MAX_CACHED_BODY_BYTES
            ) {
              // Best effort: a body that did not cache is fetched again next time.
              await cache.putBody(uid, res.value).catch(() => {});
            }
            setMessage({
              body: res.value.paragraphs,
              html: res.value.html,
              hasTextPart: res.value.hasTextPart,
              inlineImagesTruncated: res.value.inlineImagesTruncated,
              attachments: res.value.attachments,
              bodyStatus: undefined,
            });
            setFlagError(null);
          } else {
            setMessage({ bodyStatus: 'failed' });
            setFlagError(describeMailFailure(res.error, account.imap.host));
          }
        } catch (err) {
          if (generation !== sessionGeneration.current) return;
          setMessage({ bodyStatus: 'failed' });
          setFlagError(
            describeMailFailure(
              { kind: 'error', detail: err instanceof Error ? err.message : String(err) },
              account.imap.host,
            ),
          );
        } finally {
          inFlightBodiesRef.current.delete(messageId);
        }
      })();
    },
    [runOn, threads],
  );

  const markRead = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined || !thread.isUnread) return;
      setThreadFlag(threadId, 'isUnread', false);
    },
    [setThreadFlag, threads],
  );

  const markUnread = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined || thread.isUnread) return;
      setThreadFlag(threadId, 'isUnread', true);
    },
    [setThreadFlag, threads],
  );

  const toggleStar = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return;
      setThreadFlag(threadId, 'isStarred', !thread.isStarred);
    },
    [setThreadFlag, threads],
  );

  /**
   * One optimistic folder move, the shape every triage button takes: patch the thread to the
   * folders it is about to sit in, `UID MOVE` the uids that are not there yet — grouped by folder,
   * since a uid only means something inside its own mailbox — then ask for a sync. A refused MOVE
   * reverts, unless a sync landed meanwhile with the server's own answer.
   */
  const moveThreadTo = useCallback(
    (threadId: string, to: MoveTarget) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return;
      const sources = MOVE_SOURCES[to];
      const nextFolders = FOLDERS.filter(
        folder => folder === to || (thread.folders.includes(folder) && !sources.includes(folder)),
      );
      if (isDemo()) {
        patch(threadId, { folders: nextFolders });
        return;
      }

      const uidsByFolder = Map.groupBy(
        thread.messages.flatMap(message => {
          const parsed = parseThreadId(message.id);
          return parsed !== null && sources.includes(parsed.folder) ? [parsed] : [];
        }),
        parsed => parsed.folder,
      );
      // Nothing on the server to move (a thread of only your own sent mail, or one already there),
      // so nothing changes: an optimistic patch here would last exactly until the next sync.
      if (uidsByFolder.size === 0) return;
      patch(threadId, { folders: nextFolders });

      const accountAddress = thread.accountId;
      const account = accountsRef.current.find(a => a.address === accountAddress);
      const userId = userIdRef.current;
      if (account === undefined || userId === null) return;

      const syncsBefore = syncCountRef.current.get(accountAddress) ?? 0;
      void (async () => {
        let failure: MailConnectionFailure;
        try {
          const [{ moveThread }, { createMailCache }] = await Promise.all([
            import('../mail/sync'),
            import('../mail/cache'),
          ]);
          const cache = createMailCache(userId, accountAddress);
          const targets = await Promise.all(
            [...uidsByFolder].map(async ([folder, parsed]) => {
              const mark = await cache.folder(folder).getSync();
              if (mark === null) throw new Error(`${folder} has not synced`);
              return { mailbox: mark.name, uids: parsed.map(({ uid }) => uid) };
            }),
          );
          const res = await moveThread(runOn(account), targets, to);
          if (res.ok) {
            setFlagError(null);
            void syncRef.current(accountAddress);
            return;
          }
          failure = res.error;
        } catch (err) {
          failure = { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
        }
        const syncedSince = (syncCountRef.current.get(accountAddress) ?? 0) !== syncsBefore;
        // The optimistic array itself is the marker: a sync that replaced the thread meanwhile
        // handed it a new one, and that answer beats the revert.
        if (!syncedSince) {
          patch(threadId, { folders: thread.folders }, t => t.folders === nextFolders);
        }
        setFlagError(describeMailFailure(failure, account.imap.host));
        // One MOVE per source mailbox cannot be atomic across them: a failure after the first may
        // have half-happened, and only the server knows which half. Ask it.
        void syncRef.current(accountAddress);
      })();
    },
    [patch, runOn, threads],
  );

  const toggleArchive = useCallback(
    (threadId: string) => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return;
      moveThreadTo(threadId, isArchived(thread) ? 'inbox' : 'archive');
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
   * In demo the send is pretend; otherwise it is SMTP through the relay, and the copy the server
   * kept is what the Sent view and the thread show — so a stored copy asks for a sync of that
   * address rather than inventing a local message that a lock or reload would lose.
   */
  const send = useCallback(async (): Promise<Result<void, MailConnectionFailure>> => {
    if (draft === null) return { ok: true, value: undefined };
    const identity = identities.find(candidate => candidate.address === draft.identityId);
    const to = addressList(draft.to);
    const cc = addressList(draft.cc);
    const bcc = addressList(draft.bcc);
    const messageId = `<${crypto.randomUUID()}@${draft.identityId.slice(draft.identityId.indexOf('@') + 1)}>`;

    if (!isDemo()) {
      if (identity === undefined) {
        return { ok: false, error: { kind: 'error', detail: 'Pick an address to send as.' } };
      }
      const [{ sendMail }, { renderHtml }] = await Promise.all([
        import('../mail/send'),
        import('@tanstack/markdown/html'),
      ]);
      const result = await sendMail(
        identity,
        {
          to,
          cc,
          bcc,
          subject: draft.subject,
          text: draft.body,
          // A whole document, as every mail client sends: a bare fragment is what filters see
          // from templating tools (docs/knowledge/email-deliverability.md).
          html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(draft.body)}</body></html>`,
          messageId,
          inReplyTo: draft.inReplyTo,
          attachments: draft.attachments,
        },
        isInbound(identity) ? runOn(identity) : null,
      );
      if (!result.ok) return result;
      const { sentCopy } = result.value;
      const host = identity.imap?.host ?? identity.address;
      setSentCopyError(
        sentCopy === 'send-only' || sentCopy.ok
          ? null
          : sentCopy.error.kind === 'no-sent-mailbox'
            ? `sent, but ${host} has no Sent folder to keep a copy in`
            : `sent, but the copy was not stored · ${describeMailFailure(sentCopy.error, host)}`,
      );
      if (sentCopy !== 'send-only' && sentCopy.ok) void sync(identity.address);
    }

    // Only the snapshot that went out is cleared: a draft opened or edited during the send is
    // the user's, not this send's.
    if (draftRef.current === draft) {
      setDraft(null);
      const userId = userIdRef.current;
      if (userId !== null) clearDraft(userId);
    }
    return { ok: true, value: undefined };
  }, [draft, identities, runOn, sync]);

  // Every change to the open draft is written through; clears are explicit (send, discard,
  // lock), never here, so an empty first render cannot wipe the copy a reload is about to restore.
  useEffect(() => {
    const userId = userIdRef.current;
    const intent = draftIntentRef.current;
    if (draft === null || userId === null || intent === undefined) return;
    saveDraft(userId, intent, draft);
  }, [draft]);

  const value = useMemo<MailContextValue>(
    () => ({
      accounts,
      identities,
      ownedAddresses,
      threads,
      draft,
      isDemo: demo,
      recordsError,
      flagError,
      sentCopyError,
      syncStates,
      liveStates,
      sync,
      loadOlder,
      isLoadingOlder: mailbox => olderInFlight[mailbox] === true,
      seedDraft: (intent, seed) => {
        draftIntentRef.current = intent;
        const userId = userIdRef.current;
        if (intent === undefined) {
          setDraft(null);
          if (userId !== null) clearDraft(userId);
          return null;
        }
        const next: ComposeDraft = (userId !== null ? loadDraft(userId, intent) : null) ?? {
          startedAsReply: seed.body !== undefined && seed.body !== '',
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          attachments: [],
          ...seed,
          // Resolved last and never from a hardcoded id: an identity can be deleted, and a
          // seed may legitimately pass `undefined`, which a plain spread would leave in place.
          identityId: seed.identityId ?? identities[0]?.address ?? '',
        };
        setDraft(next);
        return next;
      },
      updateDraft: changes =>
        setDraft(current => (current === null ? current : { ...current, ...changes })),
      send,
      putAddress,
      removeAddress,
      setSenderName,
      attach: added =>
        setDraft(current =>
          current === null
            ? current
            : {
                ...current,
                // Same filename twice is a re-pick, not a second file.
                attachments: [
                  ...current.attachments.filter(a => !added.some(b => b.name === a.name)),
                  ...added,
                ],
              },
        ),
      detach: name =>
        setDraft(current =>
          current === null
            ? current
            : { ...current, attachments: current.attachments.filter(a => a.name !== name) },
        ),
      markRead,
      markUnread,
      toggleStar,
      loadBody,
      toggleArchive,
      trashThread,
      restoreThread,
    }),
    [
      accounts,
      identities,
      ownedAddresses,
      threads,
      draft,
      demo,
      recordsError,
      flagError,
      sentCopyError,
      syncStates,
      liveStates,
      sync,
      loadOlder,
      olderInFlight,
      putAddress,
      removeAddress,
      setSenderName,
      send,
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

/** The most recent message decides a thread's position and its list timestamp. */
export const latestOf = (thread: Thread) => {
  const latest = thread.messages.at(-1);
  if (latest === undefined) throw new Error(`Thread ${thread.id} has no messages`);
  return latest;
};

/**
 * What the list shows of a message without opening it, cut the way a mail client cuts a snippet.
 *
 * DERIVED, never authored beside the body: a hand-written preview is a second copy of the same
 * prose that drifts from it silently, and the stacked record shows enough of it that the drift
 * would be on screen. The cut is generous because that record gives the excerpt three lines; the
 * ellipsis is added only when something was actually removed.
 */
const SNIPPET = 240;

export const previewOf = (thread: Thread) => {
  const body = latestOf(thread).body.join(' ');
  return body.length <= SNIPPET ? body : `${body.slice(0, SNIPPET).trimEnd()}…`;
};

/**
 * What each view shows, as one question per view about a thread's `folders`. One table, so the
 * views and their rules sit together and adding a view does not compile until it answers. A
 * thread made only of your own sent mail is in Sent and nowhere else, as in Gmail; a thread with
 * one binned message and the rest still live shows in both its live view and Trash; an address is
 * a filter of the inbox, so it inherits the inbox's rule.
 */
const VIEW_SHOWS: Record<ViewId, (thread: ThreadState) => boolean> = {
  unified: thread => thread.folders.includes('inbox'),
  starred: thread => thread.isStarred && !isTrashed(thread),
  archive: isArchived,
  // What you sent, wherever the conversation now sits: archive hides nothing here, as in Gmail.
  sent: thread => thread.folders.includes('sent') && !isTrashed(thread),
  trash: thread => thread.folders.includes('trash'),
};

/**
 * Which IMAP folder a mailbox pages back through. Starred and an address are both filters of the
 * inbox, so paging either is paging the inbox; the other three views are their own folder.
 */
const VIEW_PAGES: Record<ViewId, Folder> = {
  unified: 'inbox',
  starred: 'inbox',
  archive: 'archive',
  sent: 'sent',
  trash: 'trash',
};

const folderPaged = (mailbox: MailboxId): Folder => {
  const view = viewIdSchema.safeParse(mailbox);
  return view.success ? VIEW_PAGES[view.data] : 'inbox';
};

/** The accounts a mailbox draws from: every one for a view, the named one for an address. */
const accountsShown = <T extends { readonly address: string }>(
  accounts: readonly T[],
  mailbox: MailboxId,
): readonly T[] =>
  isViewId(mailbox) ? accounts : accounts.filter(account => account.address === mailbox);

/**
 * Whether anything is left to page back to in this mailbox: some account it shows has synced and
 * has not reached the start of the folder it lists. An account that never synced, or whose sync
 * failed, answers no — the foot control is hidden rather than disabled when there is no more mail,
 * so nothing on screen may imply there is.
 */
export const olderAvailable = (
  syncStates: Readonly<Record<string, AccountSyncState>>,
  accounts: readonly { readonly address: string }[],
  mailbox: MailboxId,
): boolean => {
  const folder = folderPaged(mailbox);
  return accountsShown(accounts, mailbox).some(account => {
    const state = syncStates[account.address];
    return state?.status === 'synced' && !state.complete.includes(folder);
  });
};

/** Which threads a mailbox shows, newest first. */
export const threadsIn = (threads: readonly ThreadState[], mailbox: MailboxId) => {
  const view = viewIdSchema.safeParse(mailbox);
  const shows = view.success
    ? VIEW_SHOWS[view.data]
    : (thread: ThreadState) => VIEW_SHOWS.unified(thread) && thread.accountId === mailbox;
  return threads.filter(shows).toSorted((a, b) => latestOf(b).at - latestOf(a).at);
};

export const unreadCount = (threads: readonly ThreadState[], mailbox: MailboxId) =>
  threadsIn(threads, mailbox).filter(thread => thread.isUnread).length;

const matches = (haystack: string, query: string) =>
  haystack.toLowerCase().includes(query.toLowerCase());

/**
 * What the list column actually shows: the mailbox, narrowed by the search in `?q=`.
 *
 * Search reads every message's subject, sender and whole body, not the list snippet. Two reasons,
 * both learned the hard way: the snippet is drawn from the newest message, so searching it on a
 * thread you replied to searches your own reply and nothing else; and it is cut to a display
 * length, which would make that cut silently decide what is findable. Search reads the mail, the
 * list reads the snippet. Bodies are fetched on open, so until the cache slice a body that was
 * never opened is not searchable; subjects and senders always are.
 *
 * One function because two surfaces need the same answer — the list draws these rows and the status
 * line counts them — and a second copy of the predicate is a second copy that drifts.
 */
export const visibleThreads = (
  threads: readonly ThreadState[],
  mailbox: MailboxId,
  query: string | undefined,
) => {
  const trimmed = query?.trim() ?? '';
  const inMailbox = threadsIn(threads, mailbox);
  if (trimmed === '') return inMailbox;
  return inMailbox.filter(
    thread =>
      matches(thread.subject, trimmed) ||
      thread.messages.some(
        message =>
          matches(message.fromName, trimmed) ||
          matches(message.fromAddress, trimmed) ||
          matches(message.toAddress, trimmed) ||
          matches(message.body.join(' '), trimmed),
      ),
  );
};

/**
 * What a mailbox is CALLED. The id stays `unified` — it is what the URL and the store call this
 * view — but nothing on screen says so. To the reader this IS the inbox, and every address below it
 * is a filter of it.
 */
export const mailboxLabel = (mailbox: MailboxId) => (mailbox === 'unified' ? 'inbox' : mailbox);
