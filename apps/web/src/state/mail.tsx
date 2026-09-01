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
import { isJudgeAddress } from '../judge/domain';
import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  isInbound,
  parseAddressRecord,
} from '../lib/addresses';
import { isDemo } from '../lib/chrome';
import { type ComposeIntent, draftKeyOfIntent, isUntouched } from '../lib/compose';
import { clearDraft, loadDraft, saveDraft } from '../lib/draft-store';
import { type DraftRecord, openSendStateOf, parseDraftId } from '../lib/drafts';
import {
  applyOps,
  MOVE_SOURCES,
  type MoveTarget,
  type PendingChange,
  type PendingOp,
  retireOps,
} from '../lib/reconcile';
import type { SentRecord } from '../lib/sent';
import {
  type Attachment,
  type Folder,
  isArchived,
  isTrashed,
  type Message,
  type Thread,
} from '../lib/thread';
import type { MailConnectionFailure, Result } from '../mail/connection';
import type { DeleteOutcome, DraftHandle, SaveOutcome } from '../mail/draft-records';
import type { LiveManager, LiveState, LiveTask } from '../mail/live';
import type { SendEffects } from '../mail/send-machine';
import type { AccountSummaries } from '../mail/summaries';
import { threadsFromAccounts, withDrafts } from '../mail/summaries';
import type { AccountSyncState } from '../mail/sync';
import type { RecordStore } from '../vault/record-store';
import { vaultErrorMessage } from '../vault/screen-policy';
import { useVault } from '../vault/session';

/**
 * The app's mutable mail state. Threads are held in memory only: a lock drops them. `mail/` is
 * reached through dynamic imports so the TLS stack and root bundle stay out of the entry chunk.
 */

export type { AccountSyncState, MailConnectionFailure };

/** A parsed body (attachment bytes included) is cached only when the raw message was under this. */
// ponytail: one ceiling; attachments-without-bytes would let bigger mail cache too.
const MAX_CACHED_BODY_BYTES = 1024 * 1024;

/** One sentence for a failed connection, the same on Connect and on a sync. */
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

/** An optimistic move rewrites `folders` to where the messages are going until the next sync. */
/** Autosave debounce after the last keystroke. */
const DRAFT_AUTOSAVE_MS = 2_000;

/**
 * Opening a draft is a change to `draft` and would otherwise mint a version, a vault PUT and a
 * mirror refresh for untouched text. Every field the composer can change must be compared here.
 */
const sameDraftContent = (
  record: DraftRecord,
  content: Omit<DraftRecord, 'contentVersion'>,
): boolean =>
  record.from === content.from &&
  record.ownerAccount === content.ownerAccount &&
  record.to === content.to &&
  record.cc === content.cc &&
  record.bcc === content.bcc &&
  record.subject === content.subject &&
  record.body === content.body &&
  record.inReplyTo === content.inReplyTo &&
  (record.references ?? []).join(' ') === (content.references ?? []).join(' ');

/** How long a draft sits still before its IMAP copy is refreshed; longer than the autosave on purpose. */
const DRAFT_MIRROR_MS = 10_000;

/**
 * After a UIDVALIDITY change the server may hand the same uid to different mail, and the threads
 * React is still rendering predate the sync that cleared the cache. The op is dropped and its
 * error surfaces; the running sync replaces the base.
 */
const assertSameUidValidity = (
  folder: Folder,
  current: number,
  locations: readonly { readonly uidValidity: number }[],
) => {
  if (locations.every(location => location.uidValidity === current)) return;
  throw new Error(`${folder} was renumbered; reopen the conversation`);
};

/** What the composer says while the newest text has not reached the vault. */
const unsavedMessage = 'Not saved to your account yet — check your connection.';

/** A draft's content without the record store's bookkeeping fields. */
export type DraftContent = Omit<
  DraftRecord,
  'contentVersion' | 'updatedAt' | 'send' | 'unconfirmedSend' | 'sentMessageId' | 'deletedAt'
>;

/** The record fields a composed draft becomes; shared by the autosave and the closing flush. */
const contentOf = (draft: ComposeDraft, ownerAccount: string | undefined): DraftContent => ({
  from: draft.identityId,
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: draft.body,
  ...(draft.inReplyTo === undefined ? {} : { inReplyTo: draft.inReplyTo }),
  ...(draft.references === undefined ? {} : { references: [...draft.references] }),
  ...(ownerAccount === undefined ? {} : { ownerAccount }),
});

export type ThreadState = Thread & {
  /** Every mailbox this conversation occupies, across all accounts. */
  readonly folders: readonly Folder[];
  /** Per account: an address's view is a predicate over one account's copies. */
  readonly foldersByAccount: Readonly<Record<string, readonly Folder[]>>;
};

/**
 * Every destination the rail can point at. A mailbox id is a URL segment: views are a closed
 * set, an address is any email string, and an unconnected address is an in-pane state.
 */
const viewIdSchema = z.enum(['unified', 'starred', 'archive', 'sent', 'trash', 'drafts']);
type ViewId = z.infer<typeof viewIdSchema>;

export const isViewId = (value: string): value is ViewId => viewIdSchema.safeParse(value).success;

export const mailboxIdSchema = z.union([viewIdSchema, z.string().email()]);

export type MailboxId = z.infer<typeof mailboxIdSchema>;

/** A recipient field is free text: commas, semicolons and whitespace all separate. */
const addressList = (value: string): readonly string[] =>
  value
    .split(/[,;\s]+/)
    .map(address => address.trim())
    .filter(address => address !== '');

/** What became of an open composer: the human pressed Send, or closed it. */
export type ComposeDraft = {
  /** Recorded at open, not derived from the body, which changes as you type. */
  startedAsReply: boolean;
  /** The address to send as; the address is the identity id. */
  identityId: string;
  to: string;
  /** Free text like `to`. */
  cc: string;
  /** Free text like `to`; reaches the envelope only (`buildMessage` writes no `Bcc` header). */
  bcc: string;
  subject: string;
  /** Markdown source. */
  body: string;
  /** The parent's `References` then the parent itself, oldest first. Absent wherever `inReplyTo` is. */
  references?: readonly string[];
  /** `draftKey` is stable and is what the URL names; `draftId` is the version the next save states. */
  draftKey?: string;
  draftId?: string;
  /** The Message-ID a reply answers; absent on a new message or a forward. */
  inReplyTo?: string;
  /**
   * Which account's Drafts and Sent hold this message. Only a reply has one, and only until it is
   * stored. Carried on the draft because the sending address may have no mailbox of its own.
   */
  ownerAccount?: string;
  /** Picker files with their bytes read, or a forwarded message's; sent as `multipart/mixed`. */
  attachments: Attachment[];
};

/** Three outcomes: "went out but the copy did not" is neither a success nor a retryable failure. */
export type SendReport =
  | { readonly state: 'sent' }
  | { readonly state: 'sent-with-caveat'; readonly detail: string }
  | { readonly state: 'refused'; readonly detail: string; readonly draftKey: string }
  /** The machine threw rather than answering, so this cannot say whether the message went out. */
  | { readonly state: 'unsettled'; readonly detail: string };

type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

type MailContextValue = {
  accounts: readonly InboundAddress[];
  identities: readonly AddressRecord[];
  /** Every address you own, inbound or send-only. */
  ownedAddresses: readonly string[];
  threads: readonly ThreadState[];
  draft: ComposeDraft | null;
  isDemo: boolean;
  recordsError: string | null;
  /** The last refused read/star write or body fetch; cleared by the next one that works. */
  flagError: string | null;
  /** A send whose Sent-folder copy did not store; cleared by the next send that does. */
  sentCopyError: string | null;
  syncStates: Readonly<Record<string, AccountSyncState>>;
  liveStates: Readonly<Record<string, LiveState>>;
  sync: (address?: string) => Promise<void>;
  /** Pages one window further back, on every account this mailbox shows. Coalesced per account and folder. */
  loadOlder: (mailbox: MailboxId) => Promise<void>;
  /** Whether that mailbox's page is in flight. */
  isLoadingOlder: (mailbox: MailboxId) => boolean;
  /**
   * Opens, replaces or clears the draft. `?compose=` decides whether the composer is on screen
   * (`lib/compose.ts`); this follows it. A device-stored draft for the same intent wins over the
   * seed (`lib/draft-store.ts`).
   */
  /** Every live draft in the vault, other devices' included. */
  drafts: readonly DraftHandle[];
  /** Another device moved this draft on while it was open here; nothing is written until resolved. */
  draftConflict: DraftHandle | null;
  /** Set while the newest text has not reached the vault. */
  draftError: string | null;
  /** `'theirs'` replaces the editor's text with the winner; `'mine'` saves what is on screen over it. Never automatic. */
  resolveDraftConflict: (choice: 'theirs' | 'mine') => void;
  /** `'sending'`: a send is running (here or elsewhere) and the draft is frozen. `'unconfirmed'`: nobody saw SMTP's answer. */
  openSendState: 'sending' | 'unconfirmed' | null;
  /** Re-runs the unconfirmed send with the same bytes. */
  sendAgain: () => Promise<void>;
  /** Puts the unconfirmed send aside so the draft can be written again. Discard stays refused. */
  backToEditing: () => Promise<void>;
  seedDraft: (
    intent: ComposeIntent | undefined,
    seed: Partial<ComposeDraft>,
  ) => ComposeDraft | null;
  updateDraft: (changes: Partial<ComposeDraft>) => void;
  /** Writes a draft record from outside the composer (agent tools). Refused while the composer holds that draft. */
  writeDraft: (input: {
    readonly draftId?: string;
    readonly content: DraftContent;
  }) => Promise<SaveOutcome | { readonly ok: false; readonly reason: 'busy' | 'locked' }>;
  /** Throws the open draft away. The caller closes the composer afterwards. */
  discardDraft: () => Promise<void>;
  /** Tombstones a draft record from outside the composer, and expunges its IMAP copy. */
  removeDraft: (
    draftId: string,
  ) => Promise<DeleteOutcome | { readonly outcome: 'busy' | 'locked' }>;
  /**
   * Sends the draft over its identity's SMTP. Resolves at the claim, where the bytes are frozen
   * into the record; a refusal before then is an error the composer shows, and everything after
   * is reported through `settled`.
   */
  send: () => Promise<Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>>;
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
  attach: (attachments: readonly Attachment[]) => void;
  detach: (name: string) => void;
};

const MailContext = createContext<MailContextValue | null>(null);

/** Kept beside the base: a sync rebuilding the threads must not blank the message being read. */
/** The message's fields, or a failure the reader can retry. */
export type BodyOutcome =
  | { readonly status: 'failed' }
  | ({ readonly status: 'loaded' } & Pick<
      Message,
      'body' | 'html' | 'hasTextPart' | 'inlineImagesTruncated' | 'attachments'
    >);

type BodyEntry = { readonly status: 'loading' } | BodyOutcome;

const withBodies = (
  threads: readonly ThreadState[],
  bodies: Readonly<Record<string, BodyEntry>>,
): readonly ThreadState[] =>
  threads.map(thread => ({
    ...thread,
    messages: thread.messages.map(message => {
      const entry = bodies[message.id];
      if (entry === undefined) return message;
      if (entry.status !== 'loaded') return { ...message, bodyStatus: entry.status };
      const { status: _, ...fields } = entry;
      return { ...message, ...fields, bodyStatus: undefined };
    }),
  }));

/** The sending address's own account when it has a mailbox, else the one holding the conversation. */
const ownerAccountFor = (
  threads: readonly ThreadState[],
  inReplyTo: string | undefined,
  from: string,
): string | undefined => {
  if (inReplyTo === undefined) return undefined;
  const thread = threads.find(candidate =>
    candidate.messages.some(message => message.messageId === inReplyTo),
  );
  if (thread === undefined) return undefined;
  return thread.accounts.includes(from) ? from : thread.accounts[0];
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
  /** What the server last said, per account. Never patched: `ops` is laid over it at render (`lib/reconcile.ts`). */
  const [baseByAccount, setBaseByAccount] = useState<AccountSummaries>({});
  const [bodiesById, setBodiesById] = useState<Readonly<Record<string, BodyEntry>>>({});
  /** Every live draft in the vault. */
  const [drafts, setDrafts] = useState<readonly DraftHandle[]>([]);
  /** Mail sent from an address with no mailbox behind it; loaded once per unlock. */
  const [vaultSent, setVaultSent] = useState<readonly SentRecord[]>([]);
  /** Set when a save was refused because another device moved the draft on. */
  const [draftConflict, setDraftConflict] = useState<DraftHandle | null>(null);
  /** Set while the newest text is not in the vault. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [ops, setOps] = useState<readonly PendingOp[]>([]);
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, AccountSyncState>>>({});
  const [liveStates, setLiveStates] = useState<Readonly<Record<string, LiveState>>>({});
  const [flagError, setFlagError] = useState<string | null>(null);
  const [sentCopyError, setSentCopyError] = useState<string | null>(null);
  const inFlightBodiesRef = useRef<Map<string, Promise<BodyOutcome>>>(new Map());
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const draftRef = useRef<ComposeDraft | null>(null);
  draftRef.current = draft;
  // Read inside `seedDraft`, which runs from a render, so it cannot be a dependency.
  const draftsRef = useRef<readonly DraftHandle[]>([]);
  draftsRef.current = drafts;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** The intent the open draft belongs to. */
  const draftIntentRef = useRef<ComposeIntent | undefined>(undefined);
  /**
   * The draft as it opened, and the intent it opened from. A reply opens already holding text, so
   * "did anybody write anything" is measured against this. `fresh` distinguishes a restored
   * draft, which is text somebody already wrote.
   */
  const openedRef = useRef<{
    intent: ComposeIntent;
    draft: ComposeDraft;
    fresh: boolean;
  } | null>(null);
  /** Set by an explicit Discard so the close that follows does not file the draft. */
  const discardedRef = useRef(false);
  const [olderInFlight, setOlderInFlight] = useState<Readonly<Record<string, boolean>>>({});

  /** One entry per account with a sync running; `dirty` makes the loop go round again, so every request is followed by a sync that started after it. */
  const syncRunsRef = useRef<Map<string, { promise: Promise<void>; dirty: boolean }>>(new Map());
  /** Counts sync starts; an acked op is retired by the first later one to land. */
  const syncSeqRef = useRef(0);
  /** Keyed by account and folder: two mailboxes over the same folder are one page. */
  const inFlightOlderRef = useRef<Map<string, Promise<void>>>(new Map());
  const liveManagerRef = useRef<LiveManager | null>(null);
  const syncRef = useRef<(address?: string) => Promise<void>>(async () => {});
  /** Read by the unlock through a ref, so the unlock stays off the send effects' deps. */
  const sendEffectsRef = useRef<
    ((store: RecordStore, identity: AddressRecord) => SendEffects) | null
  >(null);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  // The last unlocked userId, kept across the lock so the cleanup can clear its cache.
  const lastUserIdRef = useRef<string | null>(null);
  /** Accounts whose cached threads have been read into memory this unlock. */
  const hydratedRef = useRef<Set<string>>(new Set());
  const sessionGeneration = useRef(0);

  useEffect(() => {
    if (import.meta.env.DEV && isDemo()) {
      // Dynamic so the fixture module stays out of the production bundle; the `DEV` guard is what
      // lets Vite drop the branch.
      void import('../data/mail').then(({ DEMO_ADDRESSES, THREADS }) => {
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
    if (session === null) {
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
      const lockedUserId = lastUserIdRef.current;
      lastUserIdRef.current = null;
      void (async () => {
        // The running task finishes before the clear, or a late write lands in the emptied cache.
        if (manager !== null) await manager.closeAll();
        if (lockedUserId === null) return;
        const { clearMailCache } = await import('../mail/cache');
        await clearMailCache(lockedUserId).catch(() => {});
      })();
      setRecords([]);
      setRecordsError(null);
      setBaseByAccount({});
      setBodiesById({});
      setOps([]);
      setSyncStates({});
      setLiveStates({});
      setOlderInFlight({});
      // An open draft is this user's plaintext too; the provider outlives the session.
      setDraft(null);
      setDrafts([]);
      setDraftConflict(null);
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
        // Drafts come from the vault too.
        const { listDrafts, purgeExpiredDrafts } = await import('../mail/draft-records');
        // Before listing, so an expired tombstone stops costing storage.
        await purgeExpiredDrafts(session.store, Date.now());
        const drafts = await listDrafts(session.store);
        if (!cancelled) setDrafts(drafts);
        const { listSentRecords } = await import('../mail/sent-records');
        const sent = await listSentRecords(session.store);
        if (!cancelled) setVaultSent(sent);
        // A send this vault left in flight is finished before anything else touches the draft;
        // `submitting` is skipped inside `resumeSends`.
        const { resumeSends } = await import('../mail/send-machine');
        await resumeSends(drafts, handle => {
          const identity = parsed.find(record => record.address === handle.record.from);
          const effectsFor = sendEffectsRef.current;
          return identity === undefined || effectsFor === null
            ? null
            : effectsFor(session.store, identity);
        });
        if (!cancelled) setDrafts(await listDrafts(session.store));
      } catch (err) {
        if (!cancelled) setRecordsError(vaultErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

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
        const { createMailCache } = await import('../mail/cache');
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

  // A pasted `?compose=` URL seeds the draft before the vault has answered, so heal the sender
  // once identities exist without touching anything else typed.
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
          const [{ syncAccount, cachedSummaries, prefetchBodies }, { createMailCache }] =
            await Promise.all([import('../mail/sync'), import('../mail/cache')]);
          const cache = createMailCache(userId, address);
          // The cache is the list until the server answers.
          if (!hydratedRef.current.has(address)) {
            hydratedRef.current.add(address);
            const cached = await cachedSummaries(cache);
            if (generation !== sessionGeneration.current) return;
            if (Object.values(cached).some(folder => folder.summaries.length > 0)) {
              setBaseByAccount(current => ({ ...current, [address]: cached }));
            }
          }
          const isStale = () =>
            generation !== sessionGeneration.current ||
            !accountsRef.current.some(a => a.address === address);
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
      applyOps(withBodies(threadsFromAccounts(baseByAccount, vaultSent), bodiesById), ops),
      drafts,
    );
  }, [demo, demoThreads, baseByAccount, vaultSent, bodiesById, ops, drafts]);

  /** Read by the draft writes, which run outside a render. */
  const threadsRef = useRef<readonly ThreadState[]>([]);
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

  /** Optimistic: a refused write drops the op and lands in `flagError`, not the account's sync state. */
  const setThreadFlag = useCallback(
    (threadId: string, key: 'isUnread' | 'isStarred', value: boolean): boolean => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      const change: PendingChange = { kind: 'flag', key, value };
      if (isDemo()) {
        setDemoThreads(current =>
          applyOps(current, [
            { id: crypto.randomUUID(), account: '', threadId, change, retireAtSyncSeq: null },
          ]),
        );
        return true;
      }
      if (!isMoving(threadId)) return false;

      // Split by account (its own connection, sync and uid space), then by folder (a uid only means
      // something in its own mailbox).
      const byAccount = Map.groupBy(
        thread.messages.flatMap(message => message.locations ?? []),
        location => location.account,
      );
      const userId = userIdRef.current;
      const work = [...byAccount].flatMap(([address, locations]) => {
        const account = accountsRef.current.find(a => a.address === address);
        return account === undefined
          ? []
          : [{ account, uidsByFolder: Map.groupBy(locations, location => location.folder) }];
      });
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

      const imapFlag = key === 'isUnread' ? '\\Seen' : '\\Flagged';
      const on = key === 'isUnread' ? !value : value;
      for (const [index, { account, uidsByFolder }] of work.entries()) {
        const op = ops[index];
        if (op === undefined) continue;
        void (async () => {
          let failure: MailConnectionFailure;
          try {
            const [{ setFlag }, { createMailCache }] = await Promise.all([
              import('../mail/sync'),
              import('../mail/cache'),
            ]);
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
            const res = await setFlag(runOn(account), targets, imapFlag, on);
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
        })();
      }
      return true;
    },
    [acknowledge, isMoving, runOn, threads],
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
            import('../mail/bodies'),
            import('../mail/cache'),
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
   * One optimistic folder move: an op showing the thread where it is about to sit, `UID MOVE` per
   * source folder, then a sync. One MOVE per mailbox cannot be atomic across them, so the sync
   * says which half happened.
   */
  const moveThreadTo = useCallback(
    (threadId: string, to: MoveTarget): boolean => {
      const thread = threads.find(t => t.id === threadId);
      if (thread === undefined) return false;
      const change: PendingChange = { kind: 'move', to };
      if (isDemo()) {
        setDemoThreads(current =>
          applyOps(current, [
            { id: crypto.randomUUID(), account: '', threadId, change, retireAtSyncSeq: null },
          ]),
        );
        return true;
      }
      if (!isMoving(threadId)) return false;

      const sources = MOVE_SOURCES[to];
      // Only the copies this move consumes, in every account that holds one.
      const byAccount = Map.groupBy(
        thread.messages.flatMap(message =>
          (message.locations ?? []).filter(location => sources.includes(location.folder)),
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
      // Nothing on the server to move, so no op: it would mask a base that is already right.
      if (userId === null || work.length === 0) return false;

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
            const [{ moveThread }, { createMailCache }] = await Promise.all([
              import('../mail/sync'),
              import('../mail/cache'),
            ]);
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
            const res = await moveThread(runOn(account), targets, to);
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
          void requestSync(account);
        })();
      }
      return true;
    },
    [acknowledge, isMoving, requestSync, runOn, threads],
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
        import('../judge/reset'),
        import('../mail/cache'),
        import('../mail/draft-records'),
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
  }, [accounts, runOn]);

  /** Erases a draft's IMAP copy wherever the mirror record says it is. */
  const expungeMirrorCopy = useCallback(
    async (draftKey: string) => {
      const session = sessionRef.current;
      if (draftKey === '' || session === null || isDemo()) return;
      const [{ readMirror }, { expungeMirror }] = await Promise.all([
        import('../mail/draft-records'),
        import('../mail/draft-mirror'),
      ]);
      const mirror = await readMirror(session.store, draftKey);
      const account = accounts.find(
        candidate => candidate.address === mirror?.mirror.locator?.account,
      );
      if (account === undefined) return;
      await expungeMirror(runOn(account), session.store, draftKey);
    },
    [accounts, runOn],
  );

  /** One implementation of each phase for a live send and a resumed one. */
  const sendEffectsFor = useCallback(
    (store: RecordStore, identity: AddressRecord): SendEffects => ({
      store,
      submit: async (bytes, handle) => {
        const { envelopeRecipients, submitBytes } = await import('../mail/send');
        const { record } = handle;
        return submitBytes(
          identity,
          bytes,
          envelopeRecipients({
            to: addressList(record.to),
            cc: addressList(record.cc),
            bcc: addressList(record.bcc),
          }),
        );
      },
      copyToSent: async (target, bytes, handle) => {
        const messageId = handle.record.send?.messageId ?? '';
        if (target === 'vault' || !isInbound(identity)) {
          const { sentRecordFrom, storeSentRecord } = await import('../mail/sent-records');
          await storeSentRecord(store, sentRecordFrom(handle.record, messageId, bytes, Date.now()));
          return { ok: true, value: null };
        }
        const { storeSentCopy } = await import('../mail/send');
        const copied = await storeSentCopy(runOn(identity), bytes, messageId);
        if (!copied.ok) return copied;
        // The locator says which account and folder, so a later expunge or open needs no guessing.
        return {
          ok: true,
          value: copied.value === null ? null : { ...target, ...copied.value },
        };
      },
      // Phase (4): sent, so no client should still offer it for editing.
      expungeMirror: handle => expungeMirrorCopy(handle.draftKey),
      now: Date.now,
    }),
    [runOn, expungeMirrorCopy],
  );

  sendEffectsRef.current = sendEffectsFor;

  /** Sends past their claim and still on the network; the browser asks before unloading. */
  const [sendsInFlight, setSendsInFlight] = useState(0);
  useEffect(() => {
    if (sendsInFlight === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // `preventDefault()` is the standard (Chromium); the deprecated property is what some WebKit builds read.
      event.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [sendsInFlight]);

  /** The half of a send only the network can settle. Runs with the composer already closed. */
  const settleSend = useCallback(
    async (
      store: RecordStore,
      identity: AddressRecord,
      handle: DraftHandle,
    ): Promise<SendReport> => {
      setSendsInFlight(count => count + 1);
      try {
        const { driveSend } = await import('../mail/send-machine');
        const progress = await driveSend(sendEffectsFor(store, identity), handle);
        // SMTP refused the message; the account's IMAP host is where the Sent copy was going.
        const smtpHost = identity.smtp.host;
        const imapHost = identity.imap?.host ?? identity.address;
        const dropSent = (current: readonly DraftHandle[]) =>
          current.filter(candidate => candidate.draftKey !== handle.draftKey);

        if (progress.done) {
          setSentCopyError(null);
          if (isInbound(identity)) {
            void sync(identity.address);
          } else {
            // No mailbox to sync: the vault's own copy is the message.
            const { listSentRecords } = await import('../mail/sent-records');
            setVaultSent(await listSentRecords(store));
          }
          setDrafts(dropSent);
          return { state: 'sent' };
        }
        if (progress.reason === 'refused') {
          // Re-listed first: the claim and its release moved the record on twice, so the handle this
          // device holds is two versions behind and reopening would be refused as a conflict.
          const { listDrafts } = await import('../mail/draft-records');
          setDrafts(await listDrafts(store));
          return {
            state: 'refused',
            detail: describeMailFailure(progress.error, smtpHost),
            draftKey: handle.draftKey,
          };
        }
        // `copy-pending` is the only outcome that knows the message went out.
        if (progress.reason === 'copy-pending') {
          // The status line has no title above it; the toast is already headed "Sent".
          const detail =
            progress.error.kind === 'no-sent-mailbox'
              ? `${imapHost} has no Sent folder to keep a copy in`
              : `the copy was not stored · ${describeMailFailure(progress.error, imapHost)}`;
          setSentCopyError(`sent, but ${detail}`);
          setDrafts(dropSent);
          return { state: 'sent-with-caveat', detail };
        }
        // Nobody saw SMTP's answer, so "Sent" would be invented. The draft stays listed with its phase.
        const detail = "nobody saw the server's answer · check Sent before resending";
        setSentCopyError(detail);
        return { state: 'unsettled', detail };
      } catch (error) {
        // Nothing may throw past here: the composer has closed and the "Sending…" toast has no timeout.
        const detail = `${
          error instanceof Error ? error.message : String(error)
        } · check Sent before resending`;
        setSentCopyError(`the send did not finish · ${detail}`);
        return { state: 'unsettled', detail };
      } finally {
        setSendsInFlight(count => count - 1);
      }
    },
    [sync, sendEffectsFor],
  );

  /**
   * Clears the composer's copy before the network settles: closing is discarding
   * (`seedDraft(undefined)`), and a `draftRef` still holding this draft would tombstone the record
   * the send is driving. Only the snapshot that went out is cleared.
   */
  const clearComposedDraft = useCallback((sent: ComposeDraft) => {
    if (draftRef.current !== sent) return;
    setDraft(null);
    const userId = userIdRef.current;
    if (userId !== null) clearDraft(userId);
  }, []);

  /** In demo the send is pretend; otherwise a stored copy asks for a sync rather than inventing a local message. */
  /** The owner an unstored reply should be filed under. */
  const ownerAccountOf = useCallback(
    (composing: ComposeDraft) =>
      composing.ownerAccount ??
      ownerAccountFor(threadsRef.current, composing.inReplyTo, composing.identityId),
    [],
  );

  const send = useCallback(async (): Promise<
    Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>
  > => {
    // Unreachable from the composer, which only renders Send with a draft under it.
    if (draft === null) {
      return { ok: false, error: { kind: 'error', detail: 'There is nothing to send.' } };
    }
    const identity = identities.find(candidate => candidate.address === draft.identityId);
    const messageId = `<${crypto.randomUUID()}@${draft.identityId.slice(draft.identityId.indexOf('@') + 1)}>`;

    if (!isDemo()) {
      if (identity === undefined) {
        return { ok: false, error: { kind: 'error', detail: 'Pick an address to send as.' } };
      }
      const session = sessionRef.current;
      if (session === null) {
        return { ok: false, error: { kind: 'error', detail: 'The vault is locked.' } };
      }
      const [{ claimSend, createDraft }, { buildOutgoing }, { renderHtml }] = await Promise.all([
        import('../mail/draft-records'),
        import('../mail/send'),
        import('@tanstack/markdown/html'),
      ]);

      // Every send owns a record. A compose sent inside the debounce has none yet; minting it here
      // makes a crash resumable and stops a second device sending its own copy.
      const content = {
        from: draft.identityId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        ...(draft.inReplyTo === undefined ? {} : { inReplyTo: draft.inReplyTo }),
        ...(draft.references === undefined ? {} : { references: [...draft.references] }),
        ...(ownerAccountOf(draft) === undefined ? {} : { ownerAccount: ownerAccountOf(draft) }),
      };
      const existing =
        draft.draftKey === undefined || draft.draftId === undefined
          ? null
          : { draftKey: draft.draftKey, draftId: draft.draftId };
      const created =
        existing === null ? await createDraft(session.store, content, Date.now()) : null;
      if (created !== null && !created.ok) {
        return {
          ok: false,
          error: { kind: 'error', detail: 'The draft could not be stored, so it was not sent.' },
        };
      }
      const { draftId } = existing ?? {
        draftId: created?.ok === true ? created.handle.draftId : '',
      };

      const built = buildOutgoing(identity, {
        to: addressList(draft.to),
        cc: addressList(draft.cc),
        bcc: addressList(draft.bcc),
        subject: draft.subject,
        text: draft.body,
        // A whole document: a bare fragment is what filters see from templating tools
        // (docs/knowledge/email-deliverability.md).
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(draft.body)}</body></html>`,
        messageId,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
        attachments: draft.attachments,
      });
      if (!built.ok) return built;

      // Phase (0): the bytes go into the record before SMTP sees them, so a resend is the same message.
      const claimed = await claimSend(
        session.store,
        draftId,
        {
          messageId,
          opId: crypto.randomUUID(),
          state: 'submitting',
          claimedAt: Date.now(),
          bytes: built.value.toBase64(),
          // The logical folder; the name is resolved against LIST at copy time.
          target: isInbound(identity) ? { account: identity.address, folder: 'sent' } : 'vault',
        },
        Date.now(),
        content,
      );
      if (!claimed.ok) {
        return {
          ok: false,
          error: {
            kind: 'error',
            detail:
              claimed.reason === 'sending'
                ? 'This draft is already being sent on another device.'
                : claimed.reason === 'conflict'
                  ? 'This draft was edited on another device. Reopen it before sending.'
                  : 'The draft could not be claimed for sending; check your connection.',
          },
        };
      }

      // The claim is the seam this function returns at; see DECISIONS.md, 2026-08-30.
      clearComposedDraft(draft);
      return {
        ok: true,
        value: { settled: settleSend(session.store, identity, claimed.handle) },
      };
    }

    clearComposedDraft(draft);
    return { ok: true, value: { settled: Promise.resolve<SendReport>({ state: 'sent' }) } };
  }, [draft, identities, settleSend, clearComposedDraft, ownerAccountOf]);

  // Clears are explicit (send, discard, lock), so an empty first render cannot wipe the copy a reload is about to restore.
  useEffect(() => {
    const userId = userIdRef.current;
    const intent = draftIntentRef.current;
    if (draft === null || userId === null || intent === undefined) return;
    saveDraft(userId, intent, draft);
  }, [draft]);

  /** Autosave of a vault draft: debounced, one save in flight, always the newest snapshot. A refusal is surfaced, not resolved. */
  /** The vault record behind whatever the composer has open, if any. */
  const openHandle = useMemo(
    () => drafts.find(candidate => candidate.draftKey === draft?.draftKey) ?? null,
    [drafts, draft],
  );

  /** Read by the autosave, which must not depend on it: every save changes `drafts`. */
  const openHandleRef = useRef<DraftHandle | null>(null);
  openHandleRef.current = openHandle;

  /** The account's own copy of the open draft, refreshed once typing stops. */
  useEffect(() => {
    const session = sessionRef.current;
    if (openHandle === null || session === null || isDemo()) return;
    // Frozen by a send: a mirror of newer text would contradict the bytes SMTP holds.
    if (openHandle.record.send !== undefined) return;
    const identity = identities.find(candidate => candidate.address === openHandle.record.from);
    if (identity === undefined) return;
    const timer = setTimeout(() => {
      void (async () => {
        const [
          { draftMirrorMessageId, mirrorAccountOf, mirrorDraft },
          { buildOutgoing },
          { renderHtml },
        ] = await Promise.all([
          import('../mail/draft-mirror'),
          import('../mail/send'),
          import('@tanstack/markdown/html'),
        ]);
        const address = mirrorAccountOf(openHandle.record, candidate =>
          accounts.some(account => account.address === candidate),
        );
        const account = accounts.find(candidate => candidate.address === address);
        // A send-only address belongs to no mailbox, so it has no mirror.
        if (account === undefined) return;
        const { record } = openHandle;
        const built = buildOutgoing(identity, {
          to: addressList(record.to),
          cc: addressList(record.cc),
          bcc: addressList(record.bcc),
          subject: record.subject,
          text: record.body,
          html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(record.body)}</body></html>`,
          // Derived from the draft key: the handle a later mirror and a discard both search on.
          messageId: draftMirrorMessageId(openHandle.draftKey, account.address),
          ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
          ...(record.references === undefined ? {} : { references: record.references }),
          attachments: [],
        });
        if (!built.ok) return;
        await mirrorDraft(runOn(account), session.store, openHandle, built.value, account.address);
      })();
    }, DRAFT_MIRROR_MS);
    return () => clearTimeout(timer);
  }, [openHandle, accounts, identities, runOn]);

  /** An unconfirmed send is settled by the message turning up in a Sent folder, read off the summaries. */
  useEffect(() => {
    const session = sessionRef.current;
    const unconfirmed = drafts.flatMap(handle =>
      handle.record.unconfirmedSend === undefined ? [] : [handle],
    );
    if (session === null || unconfirmed.length === 0) return;
    // `<Message-ID>\0<from>` for every message in a Sent folder. Both halves: ids collide, and a
    // message arriving with a colliding id must not tombstone a draft nobody sent.
    const sent = new Set(
      Object.values(baseByAccount).flatMap(folders =>
        (folders.sent?.summaries ?? []).flatMap(summary => {
          const messageId = summary.envelope?.messageId;
          const author = summary.envelope?.from?.[0];
          if (messageId === undefined || author?.mailbox == null || author.host == null) return [];
          return [`${messageId}\0${author.mailbox}@${author.host}`.toLowerCase()];
        }),
      ),
    );
    const settled = unconfirmed.filter(handle => {
      const pending = handle.record.unconfirmedSend;
      return (
        pending !== undefined &&
        sent.has(`${pending.messageId}\0${handle.record.from}`.toLowerCase())
      );
    });
    if (settled.length === 0) return;
    void (async () => {
      const { completeSend, listDrafts } = await import('../mail/draft-records');
      for (const handle of settled) {
        const messageId = handle.record.unconfirmedSend?.messageId;
        if (messageId === undefined) continue;
        await completeSend(session.store, handle.draftId, messageId, Date.now());
      }
      setDrafts(await listDrafts(session.store));
    })();
  }, [drafts, baseByAccount]);

  const savingRef = useRef(false);
  useEffect(() => {
    const session = sessionRef.current;
    // A draft with no text is not yet a draft.
    if (draft === null || session === null || isDemo()) return;
    // A send in flight freezes the content on every device.
    if (openHandleRef.current?.record.send !== undefined) return;
    if (draft.body === '' && draft.subject === '' && draft.to === '') return;
    const pending = draft;
    const timer = setTimeout(() => {
      if (savingRef.current) return;
      savingRef.current = true;
      void (async () => {
        try {
          const content = contentOf(pending, ownerAccountOf(pending));
          const open = openHandleRef.current;
          // Opening a draft runs this effect too.
          if (
            open !== null &&
            open.draftId === pending.draftId &&
            sameDraftContent(open.record, content)
          )
            return;
          // The first save of an ordinary compose mints the record.
          if (pending.draftId === undefined) {
            const { createDraft } = await import('../mail/draft-records');
            const created = await createDraft(session.store, content, Date.now());
            if (!created.ok) {
              setDraftError(unsavedMessage);
              return;
            }
            setDraftError(null);
            setDraft(current =>
              current === null || current.draftKey !== undefined
                ? current
                : {
                    ...current,
                    draftKey: created.handle.draftKey,
                    draftId: created.handle.draftId,
                  },
            );
            setDrafts(current => [...current, created.handle]);
            return;
          }
          const { replaceDraft } = await import('../mail/draft-records');
          const outcome = await replaceDraft(session.store, pending.draftId, content, Date.now());
          if (!outcome.ok) {
            if (outcome.reason !== 'conflict') setDraftError(unsavedMessage);
            if (outcome.reason === 'conflict' && outcome.currentDraftId !== null) {
              const { listDrafts } = await import('../mail/draft-records');
              const live = await listDrafts(session.store);
              setDrafts(live);
              const theirs = live.find(candidate => candidate.draftId === outcome.currentDraftId);
              setDraftConflict(theirs ?? null);
            }
            return;
          }
          setDraftError(null);
          // The next save must name the new version.
          setDraft(current =>
            current === null || current.draftKey !== outcome.handle.draftKey
              ? current
              : { ...current, draftId: outcome.handle.draftId },
          );
          setDrafts(current =>
            current.map(candidate =>
              candidate.draftKey === outcome.handle.draftKey ? outcome.handle : candidate,
            ),
          );
        } finally {
          savingRef.current = false;
        }
      })();
    }, DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, ownerAccountOf]);

  const resolveDraftConflict = useCallback((choice: 'theirs' | 'mine') => {
    setDraftConflict(theirs => {
      if (theirs === null) return null;
      setDraft(current => {
        if (current === null || current.draftKey !== theirs.draftKey) return current;
        // Either way the editor now names the version that won.
        return choice === 'mine'
          ? { ...current, draftId: theirs.draftId }
          : {
              ...current,
              draftId: theirs.draftId,
              identityId: theirs.record.from,
              to: theirs.record.to,
              cc: theirs.record.cc,
              bcc: theirs.record.bcc,
              subject: theirs.record.subject,
              body: theirs.record.body,
            };
      });
      return null;
    });
  }, []);

  const openSendState: 'sending' | 'unconfirmed' | null =
    openHandle === null ? null : openSendStateOf(openHandle.record, Date.now());

  const sendAgain = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const identity = identities.find(candidate => candidate.address === openHandle.record.from);
    if (identity === undefined) return;
    const [{ reclaimSend }, { driveSend }] = await Promise.all([
      import('../mail/draft-records'),
      import('../mail/send-machine'),
    ]);
    // Already claimed: carry on from the phase the record names.
    const claimed =
      openHandle.record.send === undefined
        ? await reclaimSend(session.store, openHandle.draftId, Date.now())
        : openHandle;
    if (claimed === null) return;
    await driveSend(sendEffectsFor(session.store, identity), claimed);
    const { listDrafts } = await import('../mail/draft-records');
    setDrafts(await listDrafts(session.store));
  }, [openHandle, identities, sendEffectsFor]);

  const backToEditing = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const { listDrafts, unconfirmSend } = await import('../mail/draft-records');
    await unconfirmSend(session.store, openHandle.draftId);
    setDrafts(await listDrafts(session.store));
  }, [openHandle]);

  const value = useMemo<MailContextValue>(
    () => ({
      accounts,
      identities,
      ownedAddresses,
      threads,
      draft,
      drafts,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      sendAgain,
      backToEditing,
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
          // Closing keeps the draft (see DECISIONS.md, 2026-08-31). A draft inside the debounce is
          // flushed here; a draft nobody typed into is dropped instead of filed.
          const open = draftRef.current;
          const session = sessionRef.current;
          const opened = openedRef.current;
          const discardedByHand = discardedRef.current;
          discardedRef.current = false;
          openedRef.current = null;
          setDraft(null);
          if (open === null || session === null || demo || discardedByHand) {
            if (userId !== null) clearDraft(userId);
            return null;
          }
          const abandonable =
            opened !== null &&
            opened.fresh &&
            draftKeyOfIntent(opened.intent) === null &&
            isUntouched(open, opened.draft);
          if (!abandonable) {
            // `setDraft(null)` cancelled the pending debounce, so a record existing is not evidence it holds this text.
            const content = contentOf(open, ownerAccountOf(open));
            const saved = openHandleRef.current;
            if (
              saved !== null &&
              saved.draftId === open.draftId &&
              sameDraftContent(saved.record, content)
            ) {
              // The vault already holds exactly this.
              if (userId !== null) clearDraft(userId);
              return null;
            }
            if (savingRef.current) {
              // An autosave is mid-flight with possibly older text; the snapshot stays.
              return null;
            }
            savingRef.current = true;
            void (async () => {
              try {
                const { createDraft, listDrafts, replaceDraft } = await import(
                  '../mail/draft-records'
                );
                const outcome =
                  open.draftId === undefined
                    ? await createDraft(session.store, content, Date.now())
                    : await replaceDraft(session.store, open.draftId, content, Date.now());
                if (!outcome.ok) {
                  // The snapshot is the only copy left, so it stays.
                  setDraftError(unsavedMessage);
                  return;
                }
                setDrafts(await listDrafts(session.store));
                if (userId !== null) clearDraft(userId);
              } finally {
                savingRef.current = false;
              }
            })();
            return null;
          }
          if (userId !== null) clearDraft(userId);
          // Nothing was written into it, so the autosaved record is mail nobody meant to keep.
          if (open.draftId === undefined) return null;
          const abandoned = open.draftId;
          void (async () => {
            const { deleteDraft } = await import('../mail/draft-records');
            const gone = await deleteDraft(session.store, abandoned, Date.now());
            // Refused means another device wrote since.
            if (gone.outcome !== 'deleted') return;
            void expungeMirrorCopy(open.draftKey ?? '');
            setDrafts(current => current.filter(candidate => candidate.draftKey !== open.draftKey));
          })();
          return null;
        }
        // A `draft:` intent opens a record, never creates one.
        const draftKey = draftKeyOfIntent(intent);
        if (draftKey !== null) {
          const handle = draftsRef.current.find(candidate => candidate.draftKey === draftKey);
          if (handle === undefined) {
            setDraft(null);
            return null;
          }
          const { record } = handle;
          const opened: ComposeDraft = {
            startedAsReply: record.inReplyTo !== undefined,
            identityId: record.from,
            to: record.to,
            cc: record.cc,
            bcc: record.bcc,
            subject: record.subject,
            body: record.body,
            attachments: [],
            ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
            ...(record.references === undefined ? {} : { references: record.references }),
            draftKey: handle.draftKey,
            draftId: handle.draftId,
            ...(record.ownerAccount === undefined ? {} : { ownerAccount: record.ownerAccount }),
          };
          setDraft(opened);
          openedRef.current = { intent, draft: opened, fresh: false };
          return opened;
        }

        // A restored snapshot knows which record it is; a live handle for the same key wins.
        const restored = userId === null ? null : loadDraft(userId, intent);
        const live =
          restored?.draftKey === undefined
            ? undefined
            : draftsRef.current.find(candidate => candidate.draftKey === restored.draftKey);
        const stored =
          restored === null || live === undefined
            ? restored
            : { ...restored, draftId: live.draftId };
        const merged = seed;
        const next: ComposeDraft = stored ?? {
          // The intent's seed says whether a quoted original opened with it, not the agent's text.
          startedAsReply: seed.body !== undefined && seed.body !== '',
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          attachments: [],
          ...merged,
          // Resolved last: an identity can be deleted, and a seed may pass `undefined`.
          identityId: merged.identityId ?? identities[0]?.address ?? '',
        };
        setDraft(next);
        openedRef.current = { intent, draft: next, fresh: stored === null };
        return next;
      },
      updateDraft: changes =>
        setDraft(current => (current === null ? current : { ...current, ...changes })),
      writeDraft: async ({ draftId, content }) => {
        const session = sessionRef.current;
        if (session === null || isDemo()) return { ok: false, reason: 'locked' };
        if (draftId !== undefined && draftRef.current?.draftId !== undefined) {
          const open = parseDraftId(draftId)?.key;
          if (open !== undefined && open === draftRef.current.draftKey)
            return { ok: false, reason: 'busy' };
        }
        const { createDraft, listDrafts, replaceDraft } = await import('../mail/draft-records');
        const outcome =
          draftId === undefined
            ? await createDraft(session.store, content, Date.now())
            : await replaceDraft(session.store, draftId, content, Date.now());
        if (outcome.ok) setDrafts(await listDrafts(session.store));
        return outcome;
      },
      discardDraft: async () => {
        // Read before anything awaits: closing follows immediately and clears both.
        const open = draftRef.current;
        const session = sessionRef.current;
        const userId = userIdRef.current;
        // The close that follows must not file what this just threw away.
        discardedRef.current = true;
        if (userId !== null) clearDraft(userId);
        if (open?.draftId === undefined || session === null || demo) return;
        const { deleteDraft } = await import('../mail/draft-records');
        const gone = await deleteDraft(session.store, open.draftId, Date.now());
        // Refused means another device wrote since, and that text was never discarded by anybody.
        if (gone.outcome !== 'deleted') return;
        void expungeMirrorCopy(open.draftKey ?? '');
        setDrafts(current => current.filter(candidate => candidate.draftKey !== open.draftKey));
      },
      removeDraft: async draftId => {
        const session = sessionRef.current;
        if (session === null || isDemo()) return { outcome: 'locked' };
        const key = parseDraftId(draftId)?.key;
        if (key !== undefined && key === draftRef.current?.draftKey) return { outcome: 'busy' };
        const { deleteDraft, listDrafts } = await import('../mail/draft-records');
        const outcome = await deleteDraft(session.store, draftId, Date.now());
        if (outcome.outcome === 'deleted') {
          void expungeMirrorCopy(key ?? '');
          setDrafts(await listDrafts(session.store));
        }
        return outcome;
      },
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
                // Same filename twice is a re-pick.
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
      resetDemoInbox,
    }),
    [
      accounts,
      identities,
      ownedAddresses,
      threads,
      draft,
      drafts,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      sendAgain,
      backToEditing,
      expungeMirrorCopy,
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
      resetDemoInbox,
      ownerAccountOf,
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

/** Derived from the body, never authored beside it (DECISIONS.md); the ellipsis only when something was removed. */
const SNIPPET = 240;

export const previewOf = (thread: Thread) => {
  const body = latestOf(thread).body.join(' ');
  return body.length <= SNIPPET ? body : `${body.slice(0, SNIPPET).trimEnd()}…`;
};

/** One question per view about a thread's `folders`; adding a view does not compile until it answers. */
const VIEW_SHOWS: Record<ViewId, (thread: ThreadState) => boolean> = {
  unified: thread => thread.folders.includes('inbox'),
  starred: thread => thread.isStarred && !isTrashed(thread),
  archive: isArchived,
  // What you sent, wherever the conversation now sits.
  sent: thread => thread.folders.includes('sent') && !isTrashed(thread),
  trash: thread => thread.folders.includes('trash'),
  // The vault's drafts, in whatever conversation each belongs to.
  drafts: thread => thread.folders.includes('drafts'),
};

/** Starred and an address are filters of the inbox, so paging either pages the inbox. */
const VIEW_PAGES: Record<ViewId, Folder> = {
  unified: 'inbox',
  starred: 'inbox',
  archive: 'archive',
  sent: 'sent',
  trash: 'trash',
  // Drafts are vault records, not a folder.
  drafts: 'drafts',
};

const folderPaged = (mailbox: MailboxId): Folder => {
  const view = viewIdSchema.safeParse(mailbox);
  return view.success ? VIEW_PAGES[view.data] : 'inbox';
};

/** Every account for a view, the named one for an address. */
const accountsShown = <T extends { readonly address: string }>(
  accounts: readonly T[],
  mailbox: MailboxId,
): readonly T[] =>
  isViewId(mailbox) ? accounts : accounts.filter(account => account.address === mailbox);

/** An account that never synced or failed answers no: the foot control is hidden, so nothing may imply more mail. */
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

/** Asked of the whole set on screen; asking the single-address question of `/m/unified` read "Nothing here yet" through the first sync. */
export const syncProgressIn = <T extends { readonly address: string }>(
  syncStates: Readonly<Record<string, AccountSyncState>>,
  accounts: readonly T[],
  mailbox: MailboxId,
): {
  readonly pending: readonly T[];
  readonly failed: readonly { readonly account: T; readonly failure: MailConnectionFailure }[];
} => {
  const shown = accountsShown(accounts, mailbox);
  return {
    // No state yet reads the same as mid-fetch to someone waiting.
    pending: shown.filter(account => {
      const status = syncStates[account.address]?.status;
      return status === undefined || status === 'idle' || status === 'syncing';
    }),
    failed: shown.flatMap(account => {
      const state = syncStates[account.address];
      return state?.status === 'failed' ? [{ account, failure: state.failure }] : [];
    }),
  };
};

/** Which threads a mailbox shows, newest first. */
export const threadsIn = (threads: readonly ThreadState[], mailbox: MailboxId) => {
  const view = viewIdSchema.safeParse(mailbox);
  const shows = view.success
    ? VIEW_SHOWS[view.data]
    : // An address's view is a predicate over that account's copies alone.
      (thread: ThreadState) => (thread.foldersByAccount[mailbox] ?? []).includes('inbox');
  return threads.filter(shows).toSorted((a, b) => latestOf(b).at - latestOf(a).at);
};

export const unreadCount = (threads: readonly ThreadState[], mailbox: MailboxId) =>
  threadsIn(threads, mailbox).filter(thread => thread.isUnread).length;

const matches = (haystack: string, query: string) =>
  haystack.toLowerCase().includes(query.toLowerCase());

/**
 * The mailbox narrowed by `?q=`. Search reads subject, sender and whole body, not the snippet
 * (drawn from the newest message and cut to display length). One function because the list and
 * the status line need the same answer.
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

/** The id stays `unified`; on screen this is the inbox (DECISIONS.md, "Inbox", not "Unified"). */
export const mailboxLabel = (mailbox: MailboxId) => (mailbox === 'unified' ? 'inbox' : mailbox);
