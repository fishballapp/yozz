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
/**
 * How long a vault draft waits after the last keystroke before it is written. Long enough that
 * typing a sentence is one save rather than thirty, short enough that closing the laptop mid-word
 * loses a phrase rather than a paragraph.
 */
const DRAFT_AUTOSAVE_MS = 2_000;

/**
 * Whether a save would write exactly what the vault record already holds.
 *
 * The autosave runs on every change to `draft`, and OPENING a draft is such a change. Without
 * this, putting an existing draft on screen (a click, or the agent's `navigate`) minted a new
 * content version, a vault PUT and an IMAP mirror refresh for text nobody touched, and opened a
 * window in which another device's real edit came back as a conflict.
 *
 * Every field the composer can change must be compared here: one left out is a real edit skipped.
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

/**
 * How long a draft must sit still before its IMAP copy is refreshed. Longer than the autosave on
 * purpose: the vault record is the draft and has to keep up with typing, while the copy in the
 * account's Drafts folder exists for your OTHER mail clients and costs an APPEND every time.
 */
const DRAFT_MIRROR_MS = 10_000;

/**
 * A uid means nothing across a renumbering: after a UIDVALIDITY change the server may hand the
 * same number to different mail. A sync detects the change and clears the cache, but the threads
 * React is still rendering came from before it — so between those two moments a click carries a
 * uid from the old numbering, and issuing it would flag, move or open whatever now holds it.
 *
 * Refusing is the whole point of carrying UIDVALIDITY in a location. The op is dropped and its
 * error surfaces; the sync already running replaces the base with the truth.
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

/** A draft's content, as everything outside the record store spells it: no bookkeeping fields. */
export type DraftContent = Omit<
  DraftRecord,
  'contentVersion' | 'updatedAt' | 'send' | 'unconfirmedSend' | 'sentMessageId' | 'deletedAt'
>;

/**
 * The record fields a composed draft becomes.
 *
 * Named rather than inlined because two callers build it now — the autosave, and the flush that
 * closing does for a draft the debounce has not reached — and a second hand-written copy is how
 * a field comes to be saved by one path and dropped by the other.
 */
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
  /**
   * The same, per account. An address's view is a predicate over ONE account's copies — a thread
   * archived in A and still in B's inbox belongs in B's inbox and in nobody's unified archive —
   * so the global rollup above cannot answer it.
   */
  readonly foldersByAccount: Readonly<Record<string, readonly Folder[]>>;
};

/**
 * Every destination the rail can point at. Address-first: the accounts come before the views.
 *
 * A mailbox id is a URL segment, and the URL is a boundary like any other — the id can arrive from
 * a bookmark, a typo or a pasted address. Views are a closed set; an address is any email string,
 * and an address that is not connected is an in-pane state rather than a 404.
 */
const viewIdSchema = z.enum(['unified', 'starred', 'archive', 'sent', 'trash', 'drafts']);
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

/** What became of an open composer: the human pressed Send, or closed it. */
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
  /**
   * The chain the reply announces, oldest first: the parent's `References` then the parent itself.
   * Absent wherever `inReplyTo` is.
   */
  references?: readonly string[];
  /**
   * The vault record this composer is editing, when it is editing one. `draftKey` is stable for
   * the draft's life and is what the URL names; `draftId` is the version the next save states, so
   * it moves on every save.
   */
  draftKey?: string;
  draftId?: string;
  /** The Message-ID a reply answers; absent on a new message or a forward. */
  inReplyTo?: string;
  /**
   * Which account's Drafts and Sent hold this message. Only a reply has one, and only until it is
   * stored — after that the record owns it. Carried on the draft so a save never drops it: the
   * sending address may have no mailbox of its own, and then this is the only thing that says
   * where the copy goes.
   */
  ownerAccount?: string;
  /** Picker files with their bytes read, or a forwarded message's; sent as `multipart/mixed`. */
  attachments: Attachment[];
};

/**
 * What became of a send once the network settled, for whoever reports it.
 *
 * Three outcomes, not two, because "the message went out but its copy did not" is neither a
 * success to say nothing about nor a failure to offer a retry for. A refusal names the draft it
 * left behind, which is the only handle on it once the composer has closed.
 */
export type SendReport =
  | { readonly state: 'sent' }
  | { readonly state: 'sent-with-caveat'; readonly detail: string }
  | { readonly state: 'refused'; readonly detail: string; readonly draftKey: string }
  /**
   * The machine threw rather than answering — a lazy import against a build that has been
   * replaced, a vault write that neither conflicted nor went offline. Its own state, because it
   * is the one outcome that cannot say whether the message went out: the throw may have landed
   * after SMTP accepted it.
   */
  | { readonly state: 'unsettled'; readonly detail: string };

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
  /** Every live draft in the vault. A draft started on another device is in here. */
  drafts: readonly DraftHandle[];
  /**
   * Another device moved this draft on while it was open here. Nothing is written until
   * `resolveDraftConflict` is called, so neither version is lost while this is set.
   */
  draftConflict: DraftHandle | null;
  /** Set while the newest text has not reached the vault; cleared by the save that lands. */
  draftError: string | null;
  /**
   * `'theirs'` replaces the editor's text with the version that won; `'mine'` keeps what is on
   * screen and saves it over that version. Never automatic: a machine choosing between two
   * versions of somebody's prose is the one thing it must not do here.
   */
  resolveDraftConflict: (choice: 'theirs' | 'mine') => void;
  /**
   * Where the open draft's send got to, when it did not get to the end. `'sending'` means a send
   * is running (here or on another device) and the draft is frozen; `'unconfirmed'` means one ran
   * and nobody saw SMTP's answer, so only the person can settle it.
   */
  openSendState: 'sending' | 'unconfirmed' | null;
  /** Re-runs the unconfirmed send with the SAME bytes: one message delivered twice, never two. */
  sendAgain: () => Promise<void>;
  /** Puts the unconfirmed send aside so the draft can be written again. Discard stays refused. */
  backToEditing: () => Promise<void>;
  seedDraft: (
    intent: ComposeIntent | undefined,
    seed: Partial<ComposeDraft>,
  ) => ComposeDraft | null;
  updateDraft: (changes: Partial<ComposeDraft>) => void;
  /**
   * Writes a draft record from OUTSIDE the composer — what the agent tools call.
   *
   * Refused while the composer holds that same draft: two writers on one piece of prose is the
   * conflict the banner exists for, and a tool overwriting what somebody is typing is worse than
   * a refusal it can report.
   */
  writeDraft: (input: {
    readonly draftId?: string;
    readonly content: DraftContent;
  }) => Promise<SaveOutcome | { readonly ok: false; readonly reason: 'busy' | 'locked' }>;
  /**
   * Throws the OPEN draft away: the composer's one destructive action.
   *
   * Separate from closing, which keeps it. The caller closes the composer afterwards; this only
   * settles what happens to the writing.
   */
  discardDraft: () => Promise<void>;
  /** Tombstones a draft record from outside the composer, and expunges its IMAP copy. */
  removeDraft: (
    draftId: string,
  ) => Promise<DeleteOutcome | { readonly outcome: 'busy' | 'locked' }>;
  /**
   * Sends the draft as its identity over that address's SMTP.
   *
   * It resolves at the CLAIM — the point where the bytes are frozen into the draft record and a
   * reload could finish them — not at the end of the send. Anything that refuses before then is
   * something the person can fix where they are, so it comes back as an error and the composer
   * stays up. Everything after it is several network round trips, the first on a cold connection,
   * and it is reported through `settled` because the composer is gone by then.
   */
  send: () => Promise<Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>>;
  /**
   * The flag and move actions answer `false`, and say so in `flagError`, while a move of the same
   * thread is still being confirmed: its messages' locations are what the server will change, and
   * a write aimed at them now would hit uids that are about to be gone.
   */
  markRead: (threadId: string) => boolean;
  /** Puts the whole thread back to unread; the reader closes with it, or opening would undo it. */
  markUnread: (threadId: string) => boolean;
  toggleStar: (threadId: string) => boolean;
  /**
   * Fetches a message's body if it has not been, or failed; joins a fetch already in flight.
   * Resolves with the outcome itself, not merely once the store holds it: a caller that needs the
   * text (an agent tool) reads it from here, because the render that publishes it comes later.
   */
  loadBody: (threadId: string, messageId: string) => Promise<BodyOutcome>;
  toggleArchive: (threadId: string) => boolean;
  /** Moves the whole conversation to Trash, your own sent copies included, as in Gmail. */
  trashThread: (threadId: string) => boolean;
  /** Brings a thread back to the inbox from Trash or Archive. */
  restoreThread: (threadId: string) => boolean;
  /**
   * HACKATHON ONLY (see `judge/`): puts a demo mailbox back the way it started, then re-syncs.
   * Delete with the rest of `judge/` after 2026-09-03.
   */
  resetDemoInbox: () => Promise<string>;
  putAddress: (record: AddressRecord) => Promise<void>;
  removeAddress: (address: string) => Promise<void>;
  /** Sets or clears the From display name; an empty string clears it. */
  setSenderName: (address: string, senderName: string) => Promise<void>;
  attach: (attachments: readonly Attachment[]) => void;
  detach: (name: string) => void;
};

const MailContext = createContext<MailContextValue | null>(null);

/**
 * A fetched body, kept beside the base rather than inside it: a summary holds flags and envelope
 * and no body, so a sync or a page of older mail rebuilding the threads would otherwise blank the
 * message being read — and the attachment bytes with it.
 */
/** What a body fetch ends as: the message's fields, or a failure the reader can retry. */
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

/**
 * Which account a reply belongs to: the sending address when it has a mailbox of its own, else
 * the account holding the conversation being answered.
 */
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
  /**
   * What the server last said, per account: the threads exactly as a sync, the cache at unlock or a
   * page of older mail produced them. Never patched — what the user did since is `ops`, laid over
   * this at render (`lib/reconcile.ts`), and what they read is `bodiesById`.
   */
  const [baseByAccount, setBaseByAccount] = useState<AccountSummaries>({});
  const [bodiesById, setBodiesById] = useState<Readonly<Record<string, BodyEntry>>>({});
  /** Every live draft in the vault, as the last read or save left it. */
  const [drafts, setDrafts] = useState<readonly DraftHandle[]>([]);
  /**
   * Mail sent from an address with no mailbox behind it. The vault is the only place it exists,
   * so it is loaded once per unlock and joins the same grouping pass as everything else.
   */
  const [vaultSent, setVaultSent] = useState<readonly SentRecord[]>([]);
  /**
   * Set when a save was refused because another device had moved the draft on. Nothing is written
   * until the person chooses, so neither version is lost while this is showing.
   */
  const [draftConflict, setDraftConflict] = useState<DraftHandle | null>(null);
  /**
   * Set while the newest text is NOT in the vault. Silence here would be the worst kind: someone
   * finishes typing, waits a moment, and closes a draft they believe is saved everywhere.
   */
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
  // Read inside `seedDraft`, which runs from a render rather than an effect, so the list has to
  // be reachable without being a dependency of the callback.
  const draftsRef = useRef<readonly DraftHandle[]>([]);
  draftsRef.current = drafts;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** The intent the open draft belongs to; what the stored copy is filed under. */
  const draftIntentRef = useRef<ComposeIntent | undefined>(undefined);
  /**
   * The draft exactly as it opened, and the intent it opened from.
   *
   * The snapshot is what "did anybody write anything" is measured against: a reply opens already
   * holding a recipient, a subject and the quoted original, so emptiness cannot answer that and
   * the opening state has to. The intent is what keeps that test off a draft opened BY KEY — an
   * existing draft read and closed again is not an abandoned one, and must never be dropped.
   * `fresh` is the same guard for the other way in: a draft RESTORED after a reload is text
   * somebody already wrote, however untouched it looks to the composer that reopened it.
   */
  const openedRef = useRef<{
    intent: ComposeIntent;
    draft: ComposeDraft;
    fresh: boolean;
  } | null>(null);
  /** Set by an explicit Discard so the close that follows it does not file the draft it just threw away. */
  const discardedRef = useRef(false);
  const [olderInFlight, setOlderInFlight] = useState<Readonly<Record<string, boolean>>>({});

  /**
   * One entry per account with a sync running. A request that arrives meanwhile sets `dirty`, and
   * the running loop goes round again before it resolves — so every request is followed by a sync
   * that STARTED after it, which is what retires an acknowledged op (`retireOps`).
   */
  const syncRunsRef = useRef<Map<string, { promise: Promise<void>; dirty: boolean }>>(new Map());
  /** Counts sync starts, across accounts; an acked op is retired by the first later one to land. */
  const syncSeqRef = useRef(0);
  /** Keyed by account and folder: two mailboxes over the same folder are one page. */
  const inFlightOlderRef = useRef<Map<string, Promise<void>>>(new Map());
  const liveManagerRef = useRef<LiveManager | null>(null);
  const syncRef = useRef<(address?: string) => Promise<void>>(async () => {});
  /**
   * Set below, read by the unlock: the sweep that finishes interrupted sends runs from the same
   * effects a live send does, and taking them through a ref keeps the unlock off their deps.
   */
  const sendEffectsRef = useRef<
    ((store: RecordStore, identity: AddressRecord) => SendEffects) | null
  >(null);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  // The userId of the session that was last unlocked, kept across the lock so the cleanup below can
  // clear its cache. Set only while unlocked, read only after a lock.
  const lastUserIdRef = useRef<string | null>(null);
  /** Accounts whose cached threads have been read into memory this unlock. */
  const hydratedRef = useRef<Set<string>>(new Set());
  const sessionGeneration = useRef(0);

  useEffect(() => {
    if (import.meta.env.DEV && isDemo()) {
      // Dynamic so the fixture module stays out of the production bundle; the `DEV` guard is
      // what lets Vite drop this branch, `isDemo()` alone is a runtime check it cannot see through.
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
      // A lock drops every decrypted thing, envelopes included; a sync still in flight from
      // before the lock belongs to a session that no longer exists. Bumping the generation FIRST
      // is the fence: an in-flight syncAccount checks it (via isStale) before it writes, so the
      // cache clear below cannot race a late write back in.
      sessionGeneration.current += 1;
      // Otherwise the next unlock's sync is handed the old in-flight promise and sets nothing.
      syncRunsRef.current.clear();
      inFlightOlderRef.current.clear();
      inFlightBodiesRef.current.clear();
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
      setBaseByAccount({});
      setBodiesById({});
      setOps([]);
      setSyncStates({});
      setLiveStates({});
      setOlderInFlight({});
      // An open draft is this user's plaintext too; the next unlock may be someone else's, and
      // the provider outlives the session.
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
        // Drafts come from the vault too, so one started on another device is here waiting.
        const { listDrafts, purgeExpiredDrafts } = await import('../mail/draft-records');
        // Before listing, so a tombstone past its window stops costing storage in a vault only
        // this device can read.
        await purgeExpiredDrafts(session.store, Date.now());
        const drafts = await listDrafts(session.store);
        if (!cancelled) setDrafts(drafts);
        const { listSentRecords } = await import('../mail/sent-records');
        const sent = await listSentRecords(session.store);
        if (!cancelled) setVaultSent(sent);
        /**
         * A send this vault left in flight is finished here, before anything else touches the
         * draft: the phase on the record says which step to run, so a tab closed mid-send does
         * not leave a message half-sent for ever. `submitting` is skipped inside `resumeSends` —
         * only the person may decide to send that one again.
         */
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
      /**
       * ALL of them, not the ones this address named. A message id stopped carrying an account
       * when threads went cross-account (`mid/<Message-ID>`), so a prefix filter now matches
       * nothing and would leave the removed account's plaintext in memory — and worse, leave a
       * body under a `mid/` id that a different message could later be given. Bodies are cheap
       * and re-fetchable; keeping the wrong one is not.
       */
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
          // The cache is the list until the server answers: what the last unlock left behind.
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
            // A UIDVALIDITY reset dropped the cache; the threads still on screen name invalid uids,
            // and so do the ops against them.
            if (result.state.status === 'failed' && result.state.invalidated) {
              setBaseByAccount(current => ({ ...current, [address]: {} }));
              setOps(current => current.filter(op => op.account !== address));
            }
            if (result.state.status === 'synced') {
              setBaseByAccount(current => ({ ...current, [address]: result.byFolder }));
              // This pass started after the acks it retires, on the same serial queue as the
              // commands they acknowledge, so its base already shows what those ops did.
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

  // What is on screen: the server's last word, with what was read merged in and what the user did
  // since laid over it. A sync replacing the base cannot lose a click, because the click is not IN
  // the base — it is re-applied here, on every render, until the server has shown it.
  const threads = useMemo(() => {
    if (demo) return demoThreads;
    // ONE grouping pass over every account: a conversation two of your addresses are copied on is
    // one thread, and grouping per account would leave each holding half of it.
    return withDrafts(
      applyOps(withBodies(threadsFromAccounts(baseByAccount, vaultSent), bodiesById), ops),
      drafts,
    );
  }, [demo, demoThreads, baseByAccount, vaultSent, bodiesById, ops, drafts]);

  /** Read by the draft writes, which run outside a render and must see the newest grouping. */
  const threadsRef = useRef<readonly ThreadState[]>([]);
  threadsRef.current = threads;

  /**
   * The server did what an op asked. The op keeps masking the base until a sync that starts after
   * this moment has landed: `requestSync` guarantees one, and `retireOps` picks it by seq.
   */
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

  /**
   * Whether a write may address this thread's messages now. While a move of it is pending, their
   * synced locations name uids the server is about to change, so any further op — an inverse
   * move, a flag — would go to the wrong place or nowhere; it waits for the sync that confirms
   * the move, and the caller says so.
   */
  const isMoving = useCallback(
    (threadId: string) => {
      if (!ops.some(op => op.threadId === threadId && op.change.kind === 'move')) return true;
      setFlagError('Still confirming the last move of that conversation; try again in a moment.');
      return false;
    },
    [ops],
  );

  /**
   * A flag write is optimistic: the op shows now and IMAP hears about it after. A refused write
   * drops the op and the base shows through; a refused write lands in `flagError`, not the
   * account's sync state, because the threads are still good and only one STORE was not.
   */
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

      // A thread's flag is the union of every copy's, so the write goes to all of them — split by
      // account, because each account is its own connection, its own sync and its own uid space,
      // and grouped by folder inside that, because a uid only means something in its own mailbox.
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

      // One op per account, each retired by ITS OWN account's confirming sync: an account that is
      // offline must not hold the others' writes on screen, nor be retired by their syncs.
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
      // A second caller — the reader's effect and an agent tool both asking — awaits the same fetch.
      const inFlight = inFlightBodiesRef.current.get(messageId);
      if (inFlight !== undefined) return inFlight;

      const userId = userIdRef.current;
      // Any copy will do for a body: they are the same bytes wherever they sit.
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
            // Same guard as the writes: a stale uid would fetch whatever now holds that number,
            // and showing one message's body under another's header is worse than an error.
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
   * One optimistic folder move, the shape every triage button takes: an op that shows the thread
   * where it is about to sit, `UID MOVE` for the uids that are not there yet — grouped by folder,
   * since a uid only means something inside its own mailbox — then a sync. A refused MOVE drops
   * the op; and since one MOVE per source mailbox cannot be atomic across them, the sync that
   * follows is what says which half happened.
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
      // Only the copies this move consumes, split per account. Filing a conversation files YOUR
      // copies of it, in every account that holds one: leaving the other account's copy in its
      // inbox would show the thread as filed and unfiled at once.
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
      // Nothing on the server to move (a thread of only your own sent mail, or one already there),
      // so nothing changes: an op here would mask a base that is already right.
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
   * HACKATHON ONLY (see `judge/`). The cache is dropped rather than reconciled: a reset moves
   * messages between folders, and a moved copy has a new uid, so every cached row for this
   * account is about to be wrong. The sync that follows rebuilds it from the server.
   */
  const resetDemoInbox = useCallback(async () => {
    const userId = userIdRef.current;
    // The judge mailbox by name, never `accounts[0]`: a vault holding a judge alias beside another
    // address would otherwise have the fifteen fixtures appended to whichever happened to list
    // first, and the wrong account's cache cleared.
    const account = accounts.find(candidate => isJudgeAddress(candidate.address));
    if (userId === null || account === undefined) {
      return 'No demo mailbox is connected to this vault.';
    }
    const [{ resetJudgeInbox }, { createMailCache }] = await Promise.all([
      import('../judge/reset'),
      import('../mail/cache'),
    ]);
    const outcome = await runOn(account)(resetJudgeInbox(account.address));
    if (!outcome.ok) return 'The mailbox could not be reached; try again in a moment.';
    await createMailCache(userId, account.address).clear();
    await syncRef.current(account.address);
    const { moved, reflagged, appended, missing } = outcome.value;
    if (missing.length > 0) {
      // "We tried" is not "the mailbox is the demo again": a fixture that never landed takes a
      // beat of the judge's script with it, and the Sent copy takes the cross-folder thread.
      return `Reset incomplete — ${missing.length} message(s) did not land (${missing.join(', ')}). Try again.`;
    }
    return `Inbox reset: ${moved} put back, ${reflagged} marked as they started, ${appended} restored.`;
  }, [accounts, runOn]);

  /**
   * Erases a draft's IMAP copy, wherever the mirror record says it is. The locator carries the
   * account, so a discard does not have to work out which mailbox held the copy.
   */
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

  /**
   * What the send state machine acts through, built the same way for a send you just pressed and
   * for one a reload picked up half-finished — so there is one implementation of each phase, not
   * a live one and a recovery one that can disagree.
   */
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
        // The locator says WHICH account and folder, so a later expunge or open needs no guessing.
        return {
          ok: true,
          value: copied.value === null ? null : { ...target, ...copied.value },
        };
      },
      // Phase (4): the draft is sent, so no client should still be offering it for editing.
      expungeMirror: handle => expungeMirrorCopy(handle.draftKey),
      now: Date.now,
    }),
    [runOn, expungeMirrorCopy],
  );

  sendEffectsRef.current = sendEffectsFor;

  /**
   * How many sends are past their claim and still on the network. A tab closed now leaves a
   * message the next unlock has to finish, so the browser asks first — the only thing in the app
   * that does, because it is the only state a reload cannot silently resume without the person
   * wondering whether their mail went.
   */
  const [sendsInFlight, setSendsInFlight] = useState(0);
  useEffect(() => {
    if (sendsInFlight === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // `preventDefault()` is the standard and is what Chromium honours (verified). The
      // deprecated property is still what some WebKit builds read, and this app runs there.
      event.returnValue = '';
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [sendsInFlight]);

  /**
   * The half of a send that only the network can settle: SMTP, the copy into Sent, and the sweep
   * that takes the draft's mirror out of every other client. It runs with the composer already
   * closed, so it returns what happened rather than showing it.
   */
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
        // Two different servers answer the two different failures, and naming the wrong one sends
        // somebody to check a machine that was never in the story: SMTP refused the message, the
        // account's IMAP host is where the Sent copy was going.
        const smtpHost = identity.smtp.host;
        const imapHost = identity.imap?.host ?? identity.address;
        const dropSent = (current: readonly DraftHandle[]) =>
          current.filter(candidate => candidate.draftKey !== handle.draftKey);

        if (progress.done) {
          setSentCopyError(null);
          if (isInbound(identity)) {
            void sync(identity.address);
          } else {
            // No mailbox to sync: the vault's own copy is the message, so re-read it.
            const { listSentRecords } = await import('../mail/sent-records');
            setVaultSent(await listSentRecords(store));
          }
          setDrafts(dropSent);
          return { state: 'sent' };
        }
        if (progress.reason === 'refused') {
          /**
           * Nothing went out and the record was never advanced, so the draft is still in Drafts
           * under this key — which is what the report hands back to reopen it.
           *
           * Re-listed first, because a refusal moved the record on TWICE: the claim wrote it, and
           * `driveSend` then released the claim so the person gets their draft back. The handle
           * this device is holding is two versions behind, and the composer opens a `draft:`
           * intent from that handle — so reopening a refused send and typing one character would
           * be refused as a conflict, and blame another device for an edit nobody made.
           */
          const { listDrafts } = await import('../mail/draft-records');
          setDrafts(await listDrafts(store));
          return {
            state: 'refused',
            detail: describeMailFailure(progress.error, smtpHost),
            draftKey: handle.draftKey,
          };
        }
        /**
         * `copy-pending` is the only one of these that KNOWS the message went out: SMTP accepted
         * it and only the copy is missing. So it is the only one allowed to say "Sent".
         */
        if (progress.reason === 'copy-pending') {
          /**
           * Two surfaces, one fact, and they need different sentences. The status line has no
           * title above it, so it says "sent, but …" and stands alone; the toast is already
           * headed **Sent**, and a description that opens by repeating its own title reads as
           * boilerplate. So the detail is written to follow either.
           */
          const detail =
            progress.error.kind === 'no-sent-mailbox'
              ? `${imapHost} has no Sent folder to keep a copy in`
              : `the copy was not stored · ${describeMailFailure(progress.error, imapHost)}`;
          setSentCopyError(`sent, but ${detail}`);
          setDrafts(dropSent);
          return { state: 'sent-with-caveat', detail };
        }
        /**
         * `unconfirmed` or `abandoned`: the machine is telling us nobody saw SMTP's answer, so
         * the message may or may not have gone out and only the person can settle it. Reporting
         * that as "Sent" would be the app inventing the one fact it does not have. The draft
         * stays listed, carrying the phase it reached, because Send again / Back to editing live
         * on it and this is the case that needs them.
         */
        const detail = "nobody saw the server's answer · check Sent before resending";
        setSentCopyError(detail);
        return { state: 'unsettled', detail };
      } catch (error) {
        /**
         * Nothing above may throw past this point, and that is a hard requirement rather than
         * caution: the composer has already closed, so there is nowhere left to throw TO. An
         * unhandled rejection would leave the "Sending…" toast on screen for ever — it carries no
         * timeout, because it is meant to be replaced — with no word on what happened.
         *
         * It says only what is true. Not a refusal, which would claim nothing went out and offer
         * the draft back; the record keeps whichever phase it reached, and the next unlock
         * finishes it.
         */
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
   * Clears the composer's copy of the draft that just went out, BEFORE the network settles.
   *
   * The order is load-bearing: closing the composer is discarding (`seedDraft(undefined)`), so a
   * `draftRef` still holding this draft when the dialog closes would tombstone the record the
   * send is driving. `deleteDraft` refuses a claimed record too, but that is the backstop, not
   * the design.
   *
   * Only the snapshot that went out is cleared: a draft opened or edited during the send is the
   * user's, not this send's.
   */
  const clearComposedDraft = useCallback((sent: ComposeDraft) => {
    if (draftRef.current !== sent) return;
    setDraft(null);
    const userId = userIdRef.current;
    if (userId !== null) clearDraft(userId);
  }, []);

  /**
   * In demo the send is pretend; otherwise it is SMTP through the relay, and the copy the server
   * kept is what the Sent view and the thread show — so a stored copy asks for a sync of that
   * address rather than inventing a local message that a lock or reload would lose.
   */
  /** The owner an unstored reply should be filed under, from whatever is on the draft. */
  const ownerAccountOf = useCallback(
    (composing: ComposeDraft) =>
      composing.ownerAccount ??
      ownerAccountFor(threadsRef.current, composing.inReplyTo, composing.identityId),
    [],
  );

  const send = useCallback(async (): Promise<
    Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>
  > => {
    // Unreachable from the composer, which only renders Send with a draft under it — but the
    // caller is handed a send to report on, and there is no send to report.
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

      /**
       * Every send owns a record, so the one it is sending can be frozen. A compose sent inside
       * the autosave's debounce has none yet, and minting it here costs one round trip and buys
       * the whole state machine: a crash after this point is resumable, and a second device
       * cannot start its own send of the same message.
       */
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
        // A whole document, as every mail client sends: a bare fragment is what filters see
        // from templating tools (docs/knowledge/email-deliverability.md).
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(draft.body)}</body></html>`,
        messageId,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
        attachments: draft.attachments,
      });
      if (!built.ok) return built;

      /**
       * Phase (0). The bytes go into the record BEFORE SMTP sees them: a resend after a crash has
       * to be the same message, and a second device must find the draft frozen rather than send
       * its own copy of it.
       */
      const claimed = await claimSend(
        session.store,
        draftId,
        {
          messageId,
          opId: crypto.randomUUID(),
          state: 'submitting',
          claimedAt: Date.now(),
          bytes: built.value.toBase64(),
          // The logical folder, not the server's name for it: the name is resolved against LIST
          // at copy time, and a server that renames its Sent folder must not strand a send.
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

      /**
       * The claim is the seam this function returns at. Above it every refusal is one the person
       * can act on with the draft still in front of them; below it is SMTP on a connection that
       * may be cold, the append into Sent and the mirror sweep — long enough that a frozen
       * composer reads as a broken app, and nothing the composer could do about any of it anyway.
       */
      clearComposedDraft(draft);
      return {
        ok: true,
        value: { settled: settleSend(session.store, identity, claimed.handle) },
      };
    }

    clearComposedDraft(draft);
    return { ok: true, value: { settled: Promise.resolve<SendReport>({ state: 'sent' }) } };
  }, [draft, identities, settleSend, clearComposedDraft, ownerAccountOf]);

  // Every change to the open draft is written through; clears are explicit (send, discard,
  // lock), never here, so an empty first render cannot wipe the copy a reload is about to restore.
  useEffect(() => {
    const userId = userIdRef.current;
    const intent = draftIntentRef.current;
    if (draft === null || userId === null || intent === undefined) return;
    saveDraft(userId, intent, draft);
  }, [draft]);

  /**
   * Autosave of a VAULT draft: debounced, one save in flight, always the newest snapshot.
   *
   * Debounced rather than per-keystroke because every save is a network round trip and a new
   * version; coalesced rather than queued because a queue of stale snapshots would each be
   * refused by the one after it. A refusal means another device moved the draft on, and nothing
   * is written until the person picks a side — the conflict is surfaced, not resolved.
   */
  /** The vault record behind whatever the composer has open, if it has one yet. */
  const openHandle = useMemo(
    () => drafts.find(candidate => candidate.draftKey === draft?.draftKey) ?? null,
    [drafts, draft],
  );

  /**
   * Read by the autosave, which must NOT depend on it: every save changes `drafts`, so a
   * dependency here would restart the debounce and save again for ever.
   */
  const openHandleRef = useRef<DraftHandle | null>(null);
  openHandleRef.current = openHandle;

  /**
   * The account's own copy of the open draft, refreshed once the typing stops.
   *
   * Only the open draft: it is the only one this device changes, and whichever device is editing
   * a draft is the one that owes the other clients a fresh copy of it.
   */
  useEffect(() => {
    const session = sessionRef.current;
    if (openHandle === null || session === null || isDemo()) return;
    // Frozen by a send: the bytes SMTP holds are the message, and a mirror of newer text would
    // contradict them.
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
        // A new message from a send-only address belongs to no mailbox, so it has no mirror.
        if (account === undefined) return;
        const { record } = openHandle;
        const built = buildOutgoing(identity, {
          to: addressList(record.to),
          cc: addressList(record.cc),
          bcc: addressList(record.bcc),
          subject: record.subject,
          text: record.body,
          html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(record.body)}</body></html>`,
          // Derived from the draft key, not minted per copy: it is the handle a later mirror
          // and a discard both search on to find EVERY copy of this draft.
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

  /**
   * The other way an unconfirmed send ends: the message turns up in a Sent folder, which settles
   * what SMTP never answered. The draft then becomes the tombstone it should have been.
   *
   * Only a sync can tell us this, so it is read off the summaries rather than asked of the
   * network — no extra round trip, and it works for a send another device started.
   */
  useEffect(() => {
    const session = sessionRef.current;
    const unconfirmed = drafts.flatMap(handle =>
      handle.record.unconfirmedSend === undefined ? [] : [handle],
    );
    if (session === null || unconfirmed.length === 0) return;
    /**
     * `<Message-ID>\0<from>` for every message in a SENT folder.
     *
     * Both halves matter. A Message-ID seen anywhere is not evidence: ids collide, and a message
     * ARRIVING with a colliding id would otherwise tombstone a draft nobody sent. In Sent, from
     * the address the draft sends as, is what a completed send actually looks like.
     */
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
    // A draft with no text in it is not yet a draft: opening the composer and closing it again
    // must not leave a record behind on every device.
    if (draft === null || session === null || isDemo()) return;
    // A send in flight freezes the content on every device, including the one that started it:
    // saving now would make the record disagree with the bytes SMTP was handed.
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
          // Nothing changed: opening a draft runs this effect too, and a version for text nobody
          // touched is a write, a mirror refresh and a conflict window bought for nothing.
          if (
            open !== null &&
            open.draftId === pending.draftId &&
            sameDraftContent(open.record, content)
          )
            return;
          // The FIRST save of an ordinary compose mints the record; every one after it replaces
          // the version it read. Without this, a draft started in the composer would never reach
          // the vault at all, and only the device that typed it would have it.
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
          // The version moved on, so the NEXT save must name the new one.
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
        // Either way the editor now names the version that won, so the next save states a
        // precondition the vault will accept.
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
    // Already claimed means the machine can simply carry on from the phase the record names.
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
          /**
           * Closing KEEPS the draft. A dialog's dismiss control must not be the destructive one:
           * the X and Escape mean "get me out of here" everywhere else a person has ever used
           * them, and the only thing that throws writing away is the button that says Discard.
           *
           * Two obligations come with that. A draft closed inside the autosave's debounce has no
           * record yet, so it is flushed here rather than lost with the React state — and the
           * local snapshot is cleared only once that flush lands, because a failed write with the
           * snapshot already gone is the text destroyed by the thing meant to save it.
           *
           * And a draft nobody typed into is dropped instead of filed. A mistaken Reply opens
           * holding a recipient, a subject and the quoted original, so without this every one of
           * them closed again would leave mail nobody wrote sitting in Drafts.
           */
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
            /**
             * Flush what is on screen, whether or not a record already exists.
             *
             * `setDraft(null)` above cancels the autosave's pending debounce, so the last two
             * seconds of typing were never written — a record existing is NOT evidence that it
             * holds THIS text, and clearing the snapshot on the strength of one is how closing
             * quietly eats a sentence.
             */
            const content = contentOf(open, ownerAccountOf(open));
            const saved = openHandleRef.current;
            if (
              saved !== null &&
              saved.draftId === open.draftId &&
              sameDraftContent(saved.record, content)
            ) {
              // The vault already holds exactly this, so a write would only bump the version.
              if (userId !== null) clearDraft(userId);
              return null;
            }
            if (savingRef.current) {
              // An autosave is mid-flight with possibly older text. The snapshot STAYS: it is the
              // only copy of anything typed since, and a stale restore beats a lost sentence.
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
                  // The snapshot is the only copy left, so it stays and the next open restores it.
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
          // Nothing was written into it, so the record it autosaved is mail nobody meant to keep.
          if (open.draftId === undefined) return null;
          const abandoned = open.draftId;
          void (async () => {
            const { deleteDraft } = await import('../mail/draft-records');
            const gone = await deleteDraft(session.store, abandoned, Date.now());
            // Refused means another device wrote since, so it is no longer text nobody touched.
            if (gone.outcome !== 'deleted') return;
            void expungeMirrorCopy(open.draftKey ?? '');
            setDrafts(current => current.filter(candidate => candidate.draftKey !== open.draftKey));
          })();
          return null;
        }
        // A `draft:` intent OPENS a record; it never creates one. The content is the record's,
        // not a seed's, so an unknown key shows nothing rather than starting a blank message
        // under somebody else's key.
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

        /**
         * A restored snapshot comes back already knowing which record it IS.
         *
         * Losing that was how one message became many: the words survived the reload, the
         * identity did not, and the autosave read a draft with no `draftId` and minted a second
         * record — once per reload. The stored version is only a hint, so a live handle for the
         * same key wins; when the records have not loaded yet the hint stands, and a version that
         * has since moved on surfaces as the conflict it is rather than as a duplicate.
         */
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
          // Whether a quoted original opened with it: the intent's seed says, not the agent's text.
          startedAsReply: seed.body !== undefined && seed.body !== '',
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          attachments: [],
          ...merged,
          // Resolved last and never from a hardcoded id: an identity can be deleted, and a
          // seed may legitimately pass `undefined`, which a plain spread would leave in place.
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
        // The close that follows must not file what this just threw away — including a draft
        // typed inside the autosave's debounce, which has no record to tombstone yet.
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
  // Unsent mail: the vault's drafts, in whatever conversation each belongs to.
  drafts: thread => thread.folders.includes('drafts'),
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
  // Drafts are vault records, not a folder this client pages back through.
  drafts: 'drafts',
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

/**
 * How the accounts a mailbox draws from are doing on their FIRST fetch, and which of them failed.
 *
 * A view draws from every account, so this has to be asked of the whole set on screen. Asking the
 * single-address question of `/m/unified` is what left a fresh login reading "Nothing here yet"
 * for the whole first sync — the one moment when there is genuinely nothing yet rather than
 * nothing at all.
 */
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
    // An account with no state yet has been asked for and has not answered, which reads the same
    // to someone waiting as one mid-fetch.
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
    : // An address's view is a predicate over THAT account's copies: the thread belongs here
      // when this account holds one of them in its inbox. A thread archived here and still in
      // another account's inbox is that account's business, not this one's.
      (thread: ThreadState) => (thread.foldersByAccount[mailbox] ?? []).includes('inbox');
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
