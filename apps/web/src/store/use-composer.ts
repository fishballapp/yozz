import {
  type AddressRecord,
  type InboundAddress,
  isInbound,
} from '@yozz.app/mail/addresses/record';
import {
  addressList,
  type ComposeDraft,
  type ComposeSeed,
  contentOf,
  type DraftContent,
  type DraftFile,
  draftFileOf,
  ownerAccountFor,
  sameDraftContent,
} from '@yozz.app/mail/compose/draft';
import {
  isFrozenBySend,
  openSendStateOf,
  parseDraftId,
  unconfirmedSendOf,
} from '@yozz.app/mail/compose/draft-record';
import type { DeleteOutcome, DraftHandle, SaveOutcome } from '@yozz.app/mail/compose/draft-vault';
import type { SendEffects } from '@yozz.app/mail/compose/send-machine';
import type { SentRecord } from '@yozz.app/mail/compose/sent-record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import type { AccountSummaries, VaultSentMessage } from '@yozz.app/mail/threads/summaries';
import type { Attachment, ThreadState } from '@yozz.app/mail/threads/thread';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import type { FileStore } from '@yozz.app/mail/vault/file-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SendReport } from '../compose/draft';
import { clearDraft, loadDraft, saveDraft } from '../compose/draft-device';
import { type ComposeIntent, draftKeyOfIntent, isUntouched } from '../compose/intent';
import type { ActivityTracker } from '../relay/activity';
import type { RunOn } from '../relay/live';
import { isDemo } from '../ui/chrome';
import type { useVault } from '../vault/session';
import type { SessionEnded } from '../vault/unlock';

/**
 * Split from the mailbox half, which hands it the accounts, the live connections and the threads;
 * it hands back the composer `useComposer` exposes, the drafts and actions `useMail` carries, and
 * the load and reset the session effect calls.
 */

/** Autosave debounce after the last keystroke. */
const DRAFT_AUTOSAVE_MS = 2_000;

/** How long a draft sits still before its IMAP copy is refreshed; longer than the autosave on purpose. */
const DRAFT_MIRROR_MS = 10_000;

/** What the composer says while the newest text has not reached the vault. */
const unsavedMessage = 'Not saved to your account yet — check your connection.';

/** Taken before an await: whether the session it was taken in is still the open one. */
const watchSession = (generation: RefObject<number>) => {
  const taken = generation.current;
  return () => generation.current === taken;
};

/** A send whose session ended before its claim: nothing was claimed, so nothing went out. */
const lockedBeforeSend = {
  ok: false,
  error: { kind: 'error', detail: "You're signed out." },
} as const satisfies Result<never, MailConnectionFailure>;

type SendClaim = Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>;

/**
 * One opening of the composer, from its seed to its close. Its autosave, its Send and the flush its
 * close runs all write one record, so they share what this holds, and an answer that lands after
 * it closed is applied to no other opening.
 */
type Compose = {
  readonly intent: ComposeIntent;
  /** The draft as it opened: a reply opens already holding text, so "did anybody write anything" is measured against this. */
  readonly opened: ComposeDraft;
  /** Not a restored draft, which is text somebody already wrote. */
  readonly isFresh: boolean;
  /** Set by an explicit Discard so the close that follows does not file the draft. */
  isDiscarded: boolean;
  /** The record a new compose is minted as, by whichever write needs one first. Cleared by a refusal, which minted nothing. */
  minting: Promise<SaveOutcome> | null;
  /** The autosave writing now; one at a time, since each names the version it read. */
  saving: Promise<void> | null;
  /** The version this opening last wrote, ahead of the render that puts it in the draft. */
  writtenDraftId: string | undefined;
  /** A Send is waiting or claiming: nothing else writes the record, or the claim names a stale version. */
  isSendPending: boolean;
  /** The latest Send, from its press: its claim writes the newest text itself, so the closing flush waits for it. */
  sending: Promise<SendClaim> | null;
  /** How each upload this opening started went, by file id. A Send and the closing flush wait on these. */
  readonly uploads: Map<string, Promise<DraftFile['upload']>>;
};

/** `files` with every upload under way settled: what a write may state, whenever the state last rendered. */
const withUploadsSettled = (compose: Compose, files: readonly DraftFile[]) =>
  Promise.all(
    files.map(async file => {
      const upload = await compose.uploads.get(file.id);
      return upload === undefined ? file : { ...file, upload };
    }),
  );

/** A file as an intent seeds it: a file already in R2 is named again rather than copied. */
const draftFileOfSeed = (file: Attachment, isDemoSend: boolean): DraftFile => {
  if (file.fileId !== undefined) {
    const { fileId, content: _content, ...rest } = file;
    return { ...rest, id: fileId, upload: 'uploaded' };
  }
  const upload = (() => {
    if (isDemoSend) return 'uploaded';
    return file.content === undefined ? 'failed' : 'uploading';
  })();
  return { ...file, id: crypto.randomUUID(), upload };
};

/** What a send reads files through: the session's stores. */
type VaultStores = { readonly store: RecordStore; readonly files: FileStore };

const composeOf = (intent: ComposeIntent, opened: ComposeDraft, isFresh: boolean): Compose => ({
  intent,
  opened,
  isFresh,
  isDiscarded: false,
  minting: null,
  saving: null,
  writtenDraftId: undefined,
  isSendPending: false,
  sending: null,
  uploads: new Map(),
});

/**
 * What the rest of the app reads of the composer's half, carried by `useMail`. Nothing here moves on
 * a keystroke, so no list or rail re-renders while somebody types.
 */
export type ComposerShared = {
  /** Every live draft in the vault, other devices' included. */
  drafts: readonly DraftHandle[];
  /** A send whose Sent-folder copy did not store; cleared by the next send that does. */
  sentCopyError: string | null;
  /** Writes a draft record from outside the composer (agent tools). Refused while the composer holds that draft. */
  writeDraft: (input: {
    readonly draftId?: string;
    readonly content: DraftContent;
  }) => Promise<SaveOutcome | { readonly ok: false; readonly reason: 'busy' | 'locked' | 'ended' }>;
  /** Tombstones a draft record from outside the composer, and expunges its IMAP copy. */
  removeDraft: (
    draftId: string,
  ) => Promise<DeleteOutcome | SessionEnded | { readonly outcome: 'busy' | 'locked' }>;
  /**
   * Taken before a caller's own await: whether the session it was taken in is still open. The
   * composer outlives the session, so an answer that lands after it ended is shown nowhere.
   */
  watchSession: () => () => boolean;
  /** A file kept in R2, when something on screen asks for it. */
  readStoredFile: (fileId: string) => Promise<Uint8Array<ArrayBuffer> | null>;
};

/** The open draft and what edits and sends it, carried by `useComposer` alone: it moves on every keystroke. */
export type Composer = {
  draft: ComposeDraft | null;
  /** Another device moved this draft on while it was open here; nothing is written until resolved. */
  draftConflict: DraftHandle | null;
  /** Set while the newest text has not reached the vault. */
  draftError: string | null;
  /** `'theirs'` replaces the editor's text with the winner; `'mine'` saves what is on screen over it. Never automatic. */
  resolveDraftConflict: (choice: 'theirs' | 'mine') => void;
  /** `'sending'`: a send is running (here or elsewhere) and the draft is frozen. `'unconfirmed'`: nobody saw SMTP's answer. */
  openSendState: 'sending' | 'unconfirmed' | null;
  /** No write may change the open draft: a send is running, or its lost answer waits on the person. */
  isOpenDraftFrozen: boolean;
  /** Re-runs the unconfirmed send with the same message. */
  sendAgain: () => Promise<void>;
  /** Puts the unconfirmed send aside so the draft can be written again. Discard stays refused. */
  backToEditing: () => Promise<void>;
  /**
   * `?compose=` decides whether the composer is on screen; this follows it. A device-stored draft
   * for the same intent wins over the seed.
   */
  seedDraft: (intent: ComposeIntent | undefined, seed: ComposeSeed) => ComposeDraft | null;
  updateDraft: (changes: Partial<ComposeDraft>) => void;
  /**
   * Throws the open draft away before anything awaits, so the caller closes the composer straight
   * after; the promise is the vault's answer, which arrives with the composer gone.
   */
  discardDraft: () => Promise<DeleteOutcome | SessionEnded>;
  /**
   * Sends the draft over its identity's SMTP. Waits for uploads under way, and resolves at the
   * claim, where the message is frozen into the record; a refusal before then is an error the composer shows, and everything after is
   * reported through `settled`. A send claimed as its session ends still goes out, and settles as
   * `ended`.
   */
  send: () => Promise<Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>>;
  /** Each file uploads at once, under a fresh id. */
  attach: (attachments: readonly Attachment[]) => void;
  detach: (fileId: string) => void;
  /** A new upload under a new id: a retried attempt whose answer was lost may still land under the old one. */
  retryUpload: (fileId: string) => void;
};

export const useComposerStore = ({
  session,
  identities,
  accounts,
  bindRunOn,
  currentAccount,
  sync,
  threadsRef,
  baseByAccount,
  demo,
  activity,
}: {
  session: ReturnType<typeof useVault>['session'];
  identities: readonly AddressRecord[];
  accounts: readonly InboundAddress[];
  /**
   * The IMAP runner of the session open now, refusing every task once that session has ended.
   * Taken with `watchSession`, before the first await, and carried through the work it starts.
   */
  bindRunOn: () => RunOn;
  /**
   * The inbound record an address has right now, or none once it was removed. A send already
   * claimed files its Sent copy through this, not the record it was composed from, which an edit
   * may have replaced.
   */
  currentAccount: (address: string) => InboundAddress | undefined;
  sync: (address?: string) => Promise<void>;
  /** The threads as rendered; read by the draft writes, which run outside a render. */
  threadsRef: RefObject<readonly ThreadState[]>;
  baseByAccount: AccountSummaries;
  demo: boolean;
  /** Where a send reports itself while it is on the network. */
  activity: ActivityTracker;
}) => {
  /** Every live draft in the vault. */
  const [drafts, setDrafts] = useState<readonly DraftHandle[]>([]);
  /** Mail sent from an address with no mailbox behind it; loaded once per unlock. */
  const [vaultSent, setVaultSent] = useState<readonly SentRecord[]>([]);
  /**
   * Mail this tab sent from an address with a mailbox, shown until a sync finds the mailbox's own
   * copy. Never stored: the next unlock retries a failed Sent copy, and the sync after it shows it.
   */
  const [justSent, setJustSent] = useState<readonly VaultSentMessage[]>([]);
  /** Set when a save was refused because another device moved the draft on. */
  const [draftConflict, setDraftConflict] = useState<DraftHandle | null>(null);
  /** Set while the newest text is not in the vault. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [sentCopyError, setSentCopyError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComposeDraft | null>(null);
  const draftRef = useRef<ComposeDraft | null>(null);
  draftRef.current = draft;
  // Read inside `seedDraft`, which runs from a render, so it cannot be a dependency.
  const draftsRef = useRef<readonly DraftHandle[]>([]);
  draftsRef.current = drafts;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = session?.userId ?? null;
  /** The composer's opening on screen; `null` once it closes, or the session ends. */
  const composeRef = useRef<Compose | null>(null);
  /** The pending autosave. A Send cancels it: the claim writes the newest text itself. */
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /**
   * The compose's record: minted by `mint` unless another of its writes already has, or is, since a
   * record each would send the message from one and leave the other in Drafts. Once minted it is
   * listed, and named in the draft while that compose is still the open one.
   */
  const mintRecord = useCallback(
    (compose: Compose, isCurrent: () => boolean, mint: () => Promise<SaveOutcome>) => {
      if (compose.minting !== null) return compose.minting;
      const minting = (async () => {
        const created = await mint();
        if (!created.ok) {
          compose.minting = null;
          return created;
        }
        if (!isCurrent()) return created;
        const { draftKey, draftId } = created.handle;
        compose.writtenDraftId = draftId;
        setDrafts(current => [...current, created.handle]);
        if (composeRef.current === compose) {
          setDraft(current => (current === null ? current : { ...current, draftKey, draftId }));
        }
        return created;
      })();
      compose.minting = minting;
      return minting;
    },
    [],
  );
  /**
   * Writes `content` into the compose's record: over the version named, or into the one minted for
   * it, which another write may have minted from older text.
   */
  const writeContent = useCallback(
    async (
      { createDraft, replaceDraft }: typeof import('@yozz.app/mail/compose/draft-vault'),
      compose: Compose,
      isCurrent: () => boolean,
      store: RecordStore,
      draftId: string | undefined,
      content: DraftContent,
    ): Promise<SaveOutcome> => {
      if (draftId !== undefined) return replaceDraft(store, draftId, content, Date.now());
      const minted = await mintRecord(compose, isCurrent, () =>
        createDraft(store, content, Date.now()),
      );
      if (!minted.ok || !isCurrent() || sameDraftContent(minted.handle.record, content)) {
        return minted;
      }
      return replaceDraft(store, minted.handle.draftId, content, Date.now());
    },
    [mintRecord],
  );
  /**
   * Bumped by `reset`. Whatever awaited across it holds the ended session's plaintext (a draft, a
   * sent message, a refusal), so it checks this before writing anything into state.
   */
  const sessionGeneration = useRef(0);
  /** Read by the mirror's erase after its awaits; a later session's list is harmless there, since the runner it is handed refuses once its own session has ended. */

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

  // Retired once its account holds a copy anywhere: in Sent, or wherever it has been moved since.
  useEffect(() => {
    const isSynced = ({ from, messageId }: VaultSentMessage) =>
      Object.values(baseByAccount[from] ?? {}).some(read =>
        read.summaries.some(summary => summary.envelope?.messageId === messageId),
      );
    if (!justSent.some(isSynced)) return;
    setJustSent(current => current.filter(sent => !isSynced(sent)));
  }, [baseByAccount, justSent]);

  /**
   * Erases a draft's IMAP copy wherever the mirror record says it is. Handed the store and the
   * runner, not reading the session: a send that outlives its session must not look in the next
   * one's vault, nor reach its connections.
   */
  const expungeMirrorCopy = useCallback(
    async (store: RecordStore, runOn: RunOn, draftKey: string) => {
      if (draftKey === '' || isDemo()) return;
      const [{ readMirror }, { expungeMirror }] = await Promise.all([
        import('@yozz.app/mail/compose/draft-vault'),
        import('@yozz.app/mail/compose/draft-mirror'),
      ]);
      const mirror = await readMirror(store, draftKey);
      const address = mirror?.mirror.locator?.account;
      const account = address === undefined ? undefined : currentAccount(address);
      if (account === undefined) return;
      await expungeMirror(runOn(account), store, draftKey);
    },
    [currentAccount],
  );

  /** One implementation of each phase for a live send and a resumed one, in the session it began in. */
  const sendEffectsFor = useCallback(
    (
      { store, files }: VaultStores,
      runOn: RunOn,
      /** None when the address was removed after the send was claimed. */
      identity: AddressRecord | undefined,
      /** Files this tab holds already, so a send from it doesn't download what it just uploaded. */
      held: ReadonlyMap<string, Uint8Array> = new Map(),
    ): SendEffects => ({
      store,
      readFile: async fileId => held.get(fileId) ?? files.get(fileId),
      submit: async (bytes, handle) => {
        const [{ envelopeRecipients }, { submitBytes }] = await Promise.all([
          import('@yozz.app/mail/compose/send'),
          import('../compose/submit'),
        ]);
        const { record } = handle;
        // Only a resumed send can lack it, and resume never submits.
        if (identity === undefined) {
          return { ok: false, error: { kind: 'error', detail: 'That address was removed' } };
        }
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
      copyToSent: async (target, { message, assemble }, handle) => {
        const messageId = handle.record.send?.messageId ?? '';
        if (target === 'vault' || (identity !== undefined && !isInbound(identity))) {
          const { sentRecordFrom, storeSentRecord } = await import(
            '@yozz.app/mail/compose/sent-vault'
          );
          await storeSentRecord(
            store,
            sentRecordFrom(handle.record, messageId, message, Date.now()),
          );
          return { ok: true, value: null };
        }
        // The record the address has now: an edit since the claim may have changed its login, and
        // a removal means the person dropped that mailbox, so the send finishes without a copy in it.
        const mailbox = currentAccount(handle.record.from);
        if (mailbox === undefined) return { ok: true, value: null };
        const { storeSentCopy } = await import('@yozz.app/mail/compose/send');
        const assembled = await assemble();
        if (!assembled.ok) return assembled;
        const copied = await storeSentCopy(runOn(mailbox), assembled.value, messageId);
        if (!copied.ok) return copied;
        // The locator says which account and folder, so a later expunge or open needs no guessing.
        return {
          ok: true,
          value: copied.value === null ? null : { ...target, ...copied.value },
        };
      },
      // Phase (4): sent, so no client should still offer it for editing.
      expungeMirror: handle => expungeMirrorCopy(store, runOn, handle.draftKey),
      now: Date.now,
    }),
    [expungeMirrorCopy, currentAccount],
  );

  /**
   * The half of a send only the network can settle. Runs with the composer already closed, and
   * answers to the session the send began in (`isCurrent`), which may have ended by the claim.
   */
  const settleSend = useCallback(
    async (
      stores: VaultStores,
      runOn: RunOn,
      identity: AddressRecord,
      handle: DraftHandle,
      isCurrent: () => boolean,
      held: ReadonlyMap<string, Uint8Array>,
    ): Promise<SendReport> => {
      const { store } = stores;
      // Counted across a lock too: the send is on the network either way, and a reload asks first.
      const end = activity.begin({ effect: 'write', priority: 'user' });
      try {
        const [{ driveSend }, { listSentRecords, sentRecordFrom }] = await Promise.all([
          import('@yozz.app/mail/compose/send-machine'),
          import('@yozz.app/mail/compose/sent-vault'),
        ]);
        const progress = await driveSend(sendEffectsFor(stores, runOn, identity, held), handle);
        if (!isCurrent()) return { state: 'ended' };
        // SMTP refused the message; the account's IMAP host is where the Sent copy was going.
        const smtpHost = identity.smtp.host;
        const imapHost = identity.imap?.host ?? identity.address;
        const dropSent = (current: readonly DraftHandle[]) =>
          current.filter(candidate => candidate.draftKey !== handle.draftKey);
        // Shown before Drafts lets go of it, so no render has the message in neither.
        const showSent = () => {
          const { send } = handle.record;
          if (send?.message === undefined) return;
          // Text and headers only: the mailbox's own copy holds the files.
          const {
            message: _message,
            attachments: _files,
            ...message
          } = sentRecordFrom(handle.record, send.messageId, send.message, Date.now());
          setJustSent(current => [...current, message]);
        };

        if (progress.done) {
          setSentCopyError(null);
          if (isInbound(identity)) {
            showSent();
            void sync(identity.address);
          } else {
            // No mailbox to sync: the vault's own copy is the message.
            const sent = await listSentRecords(store);
            if (!isCurrent()) return { state: 'ended' };
            setVaultSent(sent);
          }
          setDrafts(dropSent);
          return { state: 'sent' };
        }
        if (progress.reason === 'refused') {
          // Re-listed first: the claim and its release moved the record on twice, so the handle this
          // device holds is two versions behind and reopening would be refused as a conflict.
          const { listDrafts } = await import('@yozz.app/mail/compose/draft-vault');
          const live = await listDrafts(store);
          if (!isCurrent()) return { state: 'ended' };
          setDrafts(live);
          return {
            state: 'refused',
            // Only here: the draft is back, so its Reopen is there to press. The copy path has neither.
            detail: progress.isFileUnreadable
              ? `${describeMailFailure(progress.error, smtpHost)}. Reopen the draft and try again.`
              : describeMailFailure(progress.error, smtpHost),
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
          // It went out, and until the next unlock retries the copy, this tab's is the only one.
          if (isInbound(identity)) showSent();
          setDrafts(dropSent);
          return { state: 'sent-with-caveat', detail };
        }
        // Nobody saw SMTP's answer, so "Sent" would be invented. Re-listed, as on a refusal, so this
        // tab holds the version that says so and reopening offers to settle it.
        const { listDrafts } = await import('@yozz.app/mail/compose/draft-vault');
        const live = await listDrafts(store);
        if (!isCurrent()) return { state: 'ended' };
        setDrafts(live);
        const detail = "nobody saw the server's answer · check Sent before resending";
        setSentCopyError(detail);
        return { state: 'unsettled', detail };
      } catch (error) {
        // Nothing may throw past here: the composer has closed and the "Sending…" toast has no timeout.
        if (!isCurrent()) return { state: 'ended' };
        const detail = `${
          error instanceof Error ? error.message : String(error)
        } · check Sent before resending`;
        setSentCopyError(`the send did not finish · ${detail}`);
        return { state: 'unsettled', detail };
      } finally {
        end();
      }
    },
    [sync, sendEffectsFor, activity],
  );

  /**
   * Lets go of a compose its Send claimed, before the network settles, while it is still the one on
   * screen; the close that follows finds its claim and files nothing.
   */
  const clearComposedDraft = useCallback((sent: Compose) => {
    if (composeRef.current !== sent) return;
    setDraft(null);
    const userId = userIdRef.current;
    if (userId !== null) clearDraft(userId);
  }, []);

  /** The owner an unstored reply should be filed under. */
  const ownerAccountOf = useCallback(
    (composing: ComposeDraft) =>
      composing.ownerAccount ??
      ownerAccountFor(threadsRef.current, composing.inReplyTo, composing.identityId),
    [threadsRef],
  );

  /**
   * In demo the send is pretend. Otherwise the message shows from this tab's own copy until the
   * account's Sent copy syncs.
   */
  const sendCompose = useCallback(
    async (compose: Compose, pressed: ComposeDraft): Promise<SendClaim> => {
      if (!isDemo()) {
        const session = sessionRef.current;
        if (session === null) return lockedBeforeSend;
        // Taken before the first await and carried into the settling, which may outlive the session.
        const isCurrent = watchSession(sessionGeneration);
        const runOn = bindRunOn();
        clearTimeout(autosaveTimerRef.current);
        const uploaded = await withUploadsSettled(compose, pressed.attachments);
        // A save already under way moves the version the claim has to name.
        await compose.saving;
        if (!isCurrent()) return lockedBeforeSend;
        const notUploaded = uploaded.find(({ upload }) => upload !== 'uploaded');
        if (notUploaded !== undefined) {
          return {
            ok: false,
            error: {
              kind: 'error',
              detail: `${notUploaded.name} failed to upload. Retry or remove it before sending.`,
            },
          };
        }
        // Waiting for an upload left the composer open, so the newest text is what goes.
        const newest = composeRef.current === compose ? (draftRef.current ?? pressed) : pressed;
        const draft = { ...newest, attachments: uploaded };
        const identity = identities.find(candidate => candidate.address === draft.identityId);
        if (identity === undefined) {
          return { ok: false, error: { kind: 'error', detail: 'Pick an address to send as.' } };
        }
        const content = contentOf(draft, ownerAccountOf(draft));
        const [{ claimSend, createDraft }, { claimOf }] = await Promise.all([
          import('@yozz.app/mail/compose/draft-vault'),
          import('@yozz.app/mail/compose/send'),
        ]);
        // An ended session mints and claims nothing, so nothing goes out on its behalf.
        if (!isCurrent()) return lockedBeforeSend;
        // Every send owns a record. A compose sent inside the debounce has none yet; minting it here
        // makes a crash resumable and stops a second device sending its own copy.
        const draftId = await (async () => {
          const written = compose.writtenDraftId ?? draft.draftId;
          if (written !== undefined) return written;
          const created = await mintRecord(compose, isCurrent, () =>
            createDraft(session.store, content, Date.now()),
          );
          return created.ok ? created.handle.draftId : null;
        })();
        if (!isCurrent()) return lockedBeforeSend;
        if (draftId === null) {
          return {
            ok: false,
            error: { kind: 'error', detail: 'The draft could not be stored, so it was not sent.' },
          };
        }

        const claim = claimOf(identity, parseDraftId(draftId)?.key ?? '', content, Date.now());
        if (!claim.ok) return claim;

        // Phase (0): the message goes into the record before SMTP sees it, so a resend is the same one.
        const claimed = await claimSend(session.store, draftId, claim.value, Date.now(), content);
        if (!claimed.ok) {
          return {
            ok: false,
            error: {
              kind: 'error',
              detail: (() => {
                if (claimed.reason === 'sending') {
                  return 'This draft is already being sent on another device.';
                }
                if (claimed.reason === 'conflict') {
                  return 'This draft was edited on another device. Reopen it before sending.';
                }
                return 'The draft could not be claimed for sending; check your connection.';
              })(),
            },
          };
        }

        // The claim is the seam this function returns at; see DECISIONS.md, 2026-08-30.
        clearComposedDraft(compose);
        return {
          ok: true,
          // Claimed, so it goes out even if the session ended under the claim; never a second time.
          value: {
            settled: settleSend(
              session,
              runOn,
              identity,
              claimed.handle,
              isCurrent,
              new Map(
                uploaded.flatMap(({ id, content }) =>
                  content === undefined ? [] : [[id, content]],
                ),
              ),
            ),
          },
        };
      }

      clearComposedDraft(compose);
      return { ok: true, value: { settled: Promise.resolve<SendReport>({ state: 'sent' }) } };
    },
    [identities, bindRunOn, settleSend, clearComposedDraft, ownerAccountOf, mintRecord],
  );

  const send = useCallback(async (): Promise<SendClaim> => {
    const compose = composeRef.current;
    // Unreachable from the composer, which only renders Send with a draft under it.
    if (draft === null || compose === null) {
      return { ok: false, error: { kind: 'error', detail: 'There is nothing to send.' } };
    }
    compose.isSendPending = true;
    // Held before anything awaits, so a close under way waits for the claim.
    compose.sending = (async () => {
      let claimed: SendClaim | undefined;
      try {
        claimed = await sendCompose(compose, draft);
        return claimed;
      } finally {
        if (claimed?.ok !== true) {
          compose.isSendPending = false;
          // Whatever was typed during the wait is unsaved, and only a change to the draft re-arms it.
          if (composeRef.current === compose) {
            setDraft(current => (current === null ? current : { ...current }));
          }
        }
      }
    })();
    return compose.sending;
  }, [draft, sendCompose]);

  // Clears are explicit (send, discard, lock), so an empty first render cannot wipe the copy a reload is about to restore.
  useEffect(() => {
    const userId = userIdRef.current;
    const compose = composeRef.current;
    if (draft === null || userId === null || compose === null) return;
    saveDraft(userId, compose.intent, draft);
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
      const isCurrent = watchSession(sessionGeneration);
      const runOn = bindRunOn();
      void (async () => {
        const [{ draftMirrorMessageId, mirrorAccountOf, mirrorDraft }, { buildOutgoing }] =
          await Promise.all([
            import('@yozz.app/mail/compose/draft-mirror'),
            import('@yozz.app/mail/compose/send'),
          ]);
        // The live connections are the next session's by now.
        if (!isCurrent()) return;
        const address = mirrorAccountOf(openHandle.record, candidate =>
          accounts.some(account => account.address === candidate),
        );
        const account = accounts.find(candidate => candidate.address === address);
        // A send-only address belongs to no mailbox, so it has no mirror.
        if (account === undefined) return;
        const { record } = openHandle;
        // The mirror holds no files, so the head is the whole message.
        const built = buildOutgoing(identity, {
          to: addressList(record.to),
          cc: addressList(record.cc),
          bcc: addressList(record.bcc),
          subject: record.subject,
          text: record.body,
          // Derived from the draft key: the handle a later mirror and a discard both search on.
          messageId: draftMirrorMessageId(openHandle.draftKey, account.address),
          ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
          ...(record.references === undefined ? {} : { references: record.references }),
          attachments: [],
        });
        if (!built.ok) return;
        await mirrorDraft(
          runOn(account),
          session.store,
          openHandle,
          built.value.head,
          account.address,
        );
      })();
    }, DRAFT_MIRROR_MS);
    return () => clearTimeout(timer);
  }, [openHandle, accounts, identities, bindRunOn]);

  /** An unconfirmed send is settled by the message turning up in a Sent folder, read off the summaries. */
  useEffect(() => {
    const session = sessionRef.current;
    const unconfirmed = drafts.flatMap(handle =>
      unconfirmedSendOf(handle.record) === undefined ? [] : [handle],
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
      const pending = unconfirmedSendOf(handle.record);
      return (
        pending !== undefined &&
        sent.has(`${pending.messageId}\0${handle.record.from}`.toLowerCase())
      );
    });
    if (settled.length === 0) return;
    const isCurrent = watchSession(sessionGeneration);
    void (async () => {
      const { completeSend, listDrafts } = await import('@yozz.app/mail/compose/draft-vault');
      for (const handle of settled) {
        const messageId = unconfirmedSendOf(handle.record)?.messageId;
        // Each one, since the last completion's round trip may have spanned a lock.
        if (!isCurrent()) return;
        if (messageId === undefined) continue;
        await completeSend(session.store, handle.draftId, messageId, Date.now());
      }
      const live = await listDrafts(session.store);
      if (isCurrent()) setDrafts(live);
    })();
  }, [drafts, baseByAccount]);

  useEffect(() => {
    const session = sessionRef.current;
    const compose = composeRef.current;
    // A draft with no text is not yet a draft.
    if (draft === null || compose === null || session === null || isDemo()) return;
    // A send in flight freezes the content on every device.
    if (openHandleRef.current?.record.send !== undefined) return;
    // Its claim writes the newest text itself; an upload settling meanwhile would re-arm this.
    if (compose.isSendPending) return;
    if (
      draft.body === '' &&
      draft.subject === '' &&
      draft.to === '' &&
      !draft.attachments.some(({ upload }) => upload === 'uploaded')
    ) {
      return;
    }
    const pending = draft;
    const timer = setTimeout(() => {
      // One save at a time; a compose closed under the timer is its closing flush's to file.
      if (compose.saving !== null || composeRef.current !== compose) return;
      const isCurrent = watchSession(sessionGeneration);
      // Its own promise: a save that finds nothing to do ends before an `async` call could return one.
      const saved = Promise.withResolvers<void>();
      compose.saving = saved.promise;
      void (async () => {
        try {
          const content = contentOf(pending, ownerAccountOf(pending));
          const open = openHandleRef.current;
          // Opening a draft runs this effect too.
          if (
            open !== null &&
            open.draftId === pending.draftId &&
            sameDraftContent(open.record, content)
          ) {
            return;
          }
          const vault = await import('@yozz.app/mail/compose/draft-vault');
          if (!isCurrent()) return;
          // The first save of an ordinary compose mints the record.
          const outcome = await writeContent(
            vault,
            compose,
            isCurrent,
            session.store,
            pending.draftId,
            content,
          );
          if (!isCurrent()) return;
          // A refusal is said in the compose it belongs to, never in the next one.
          const isOpen = composeRef.current === compose;
          if (!outcome.ok) {
            if (!isOpen) return;
            if (outcome.reason !== 'conflict') setDraftError(unsavedMessage);
            if (outcome.reason === 'conflict' && outcome.currentDraftId !== null) {
              const live = await vault.listDrafts(session.store);
              if (!isCurrent()) return;
              setDrafts(live);
              if (composeRef.current !== compose) return;
              const theirs = live.find(candidate => candidate.draftId === outcome.currentDraftId);
              setDraftConflict(theirs ?? null);
            }
            return;
          }
          if (isOpen) setDraftError(null);
          compose.writtenDraftId = outcome.handle.draftId;
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
          compose.saving = null;
          saved.resolve();
        }
      })();
    }, DRAFT_AUTOSAVE_MS);
    autosaveTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [draft, ownerAccountOf, writeContent]);

  const resolveDraftConflict = useCallback((choice: 'theirs' | 'mine') => {
    setDraftConflict(theirs => {
      if (theirs === null) return null;
      if (composeRef.current !== null) composeRef.current.writtenDraftId = theirs.draftId;
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
              attachments: (theirs.record.attachments ?? []).map(draftFileOf),
            };
      });
      return null;
    });
  }, []);

  const openSendState: 'sending' | 'unconfirmed' | null =
    openHandle === null ? null : openSendStateOf(openHandle.record, Date.now());
  const isOpenDraftFrozen = openHandle !== null && isFrozenBySend(openHandle.record, Date.now());

  const sendAgain = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const identity = identities.find(candidate => candidate.address === openHandle.record.from);
    if (identity === undefined) return;
    const isCurrent = watchSession(sessionGeneration);
    const runOn = bindRunOn();
    const [{ reclaimSend }, { driveSend }] = await Promise.all([
      import('@yozz.app/mail/compose/draft-vault'),
      import('@yozz.app/mail/compose/send-machine'),
    ]);
    // As `send`: an ended session claims nothing.
    if (!isCurrent()) return;
    // A lost answer goes back under a fresh claim; any other claim carries on from its phase.
    const claimed =
      unconfirmedSendOf(openHandle.record) !== undefined
        ? await reclaimSend(session.store, openHandle.draftId, Date.now())
        : openHandle;
    if (claimed === null) return;
    await driveSend(sendEffectsFor(session, runOn, identity), claimed);
    if (!isCurrent()) return;
    const { listDrafts } = await import('@yozz.app/mail/compose/draft-vault');
    const live = await listDrafts(session.store);
    if (isCurrent()) setDrafts(live);
  }, [openHandle, identities, bindRunOn, sendEffectsFor]);

  const backToEditing = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const isCurrent = watchSession(sessionGeneration);
    const { listDrafts, unconfirmSend } = await import('@yozz.app/mail/compose/draft-vault');
    if (!isCurrent()) return;
    await unconfirmSend(session.store, openHandle.draftId);
    const live = await listDrafts(session.store);
    if (isCurrent()) setDrafts(live);
  }, [openHandle]);

  /** The vault's drafts and sent records, then the sends this vault left in flight. */
  const load = useCallback(
    async (stores: VaultStores, records: readonly AddressRecord[], isCancelled: () => boolean) => {
      const { store, files } = stores;
      // Before the first await: a send resumed below copies into this session's mailboxes or nowhere.
      const runOn = bindRunOn();
      // Drafts come from the vault too.
      const [{ listDrafts, purgeExpiredDrafts }, { collectFiles }] = await Promise.all([
        import('@yozz.app/mail/compose/draft-vault'),
        import('@yozz.app/mail/vault/collect-files'),
      ]);
      // Before listing, so an expired tombstone stops costing storage.
      await purgeExpiredDrafts(store, Date.now());
      const drafts = await listDrafts(store);
      if (isCancelled()) return;
      setDrafts(drafts);
      const { listSentRecords } = await import('@yozz.app/mail/compose/sent-vault');
      const sent = await listSentRecords(store);
      // An ended session resumes nothing; the next unlock of this vault finds the same phases.
      if (isCancelled()) return;
      setVaultSent(sent);
      // A send this vault left in flight is finished before anything else touches the draft;
      // `submitting` is skipped inside `resumeSends`.
      const { resumeSends } = await import('@yozz.app/mail/compose/send-machine');
      if (isCancelled()) return;
      // Asked again before each send: one that ran on finishes, but none starts after a lock.
      await resumeSends(drafts, handle => {
        if (isCancelled()) return null;
        const identity = records.find(record => record.address === handle.record.from);
        // An address removed since the claim still gets its send finished, without a copy.
        return sendEffectsFor(stores, runOn, identity);
      });
      // Checked after the read: one that spans a lock holds this user's drafts.
      const live = await listDrafts(store);
      if (isCancelled()) return;
      setDrafts(live);
      // A resume may have moved a send-only message out of Drafts and into Sent.
      const sentNow = await listSentRecords(store);
      if (isCancelled()) return;
      setVaultSent(sentNow);
      // Last, and in the background: nothing on screen waits for it, and the next unlock tries again.
      void collectFiles(store, files, Date.now()).catch(() => undefined);
    },
    [bindRunOn, sendEffectsFor],
  );

  /**
   * Takes a draft off the list before the vault answers. A refusal puts back the version the list
   * showed, unless a re-list has brought the row back meanwhile. No re-list on success: a tombstone
   * moves only its own record, so every other handle still names its newest version.
   */
  const dropDraft = useCallback(
    async (
      store: RecordStore,
      draftKey: string,
      /** Handed `isCurrent`, so a tombstone that writes twice starts no second write after a lock. */
      tombstone: (
        vault: typeof import('@yozz.app/mail/compose/draft-vault'),
        isCurrent: () => boolean,
      ) => Promise<DeleteOutcome>,
    ): Promise<DeleteOutcome | SessionEnded> => {
      const isIt = (candidate: DraftHandle) => candidate.draftKey === draftKey;
      const shown = draftsRef.current.find(isIt);
      const isCurrent = watchSession(sessionGeneration);
      const runOn = bindRunOn();
      setDrafts(current => current.filter(candidate => !isIt(candidate)));
      const outcome = await (async (): Promise<DeleteOutcome | SessionEnded> => {
        try {
          const vault = await import('@yozz.app/mail/compose/draft-vault');
          // An ended session tombstones nothing; the draft stays in that vault's Drafts.
          if (!isCurrent()) return { outcome: 'ended' };
          return await tombstone(vault, isCurrent);
        } catch {
          return { outcome: 'offline' };
        }
      })();
      if (!isCurrent()) return { outcome: 'ended' };
      if (outcome.outcome === 'deleted') void expungeMirrorCopy(store, runOn, draftKey);
      if (outcome.outcome === 'deleted' || outcome.outcome === 'absent') {
        // Again: a re-list that read before the tombstone landed has put the row back.
        setDrafts(current => current.filter(candidate => !isIt(candidate)));
        return outcome;
      }
      if (shown !== undefined) {
        setDrafts(current => (current.some(isIt) ? current : [...current, shown]));
      }
      return outcome;
    },
    [bindRunOn, expungeMirrorCopy],
  );

  /** Everything here is this user's plaintext; the provider outlives the session. */
  const reset = useCallback((userId: string) => {
    sessionGeneration.current += 1;
    composeRef.current = null;
    setVaultSent([]);
    setJustSent([]);
    setSentCopyError(null);
    setDraftError(null);
    setDraft(null);
    setDrafts([]);
    setDraftConflict(null);
    clearDraft(userId);
  }, []);

  const writeDraft = useCallback<ComposerShared['writeDraft']>(async ({ draftId, content }) => {
    const session = sessionRef.current;
    if (session === null || isDemo()) return { ok: false, reason: 'locked' };
    if (draftId !== undefined && draftRef.current?.draftId !== undefined) {
      const open = parseDraftId(draftId)?.key;
      if (open !== undefined && open === draftRef.current.draftKey) {
        return { ok: false, reason: 'busy' };
      }
    }
    const isCurrent = watchSession(sessionGeneration);
    const { createDraft, listDrafts, replaceDraft } = await import(
      '@yozz.app/mail/compose/draft-vault'
    );
    if (!isCurrent()) return { ok: false, reason: 'ended' };
    const outcome =
      draftId === undefined
        ? await createDraft(session.store, content, Date.now())
        : await replaceDraft(session.store, draftId, content, Date.now());
    if (!isCurrent()) return { ok: false, reason: 'ended' };
    if (!outcome.ok) return outcome;
    const live = await listDrafts(session.store);
    if (!isCurrent()) return { ok: false, reason: 'ended' };
    setDrafts(live);
    return outcome;
  }, []);

  const removeDraft = useCallback<ComposerShared['removeDraft']>(
    async draftId => {
      const session = sessionRef.current;
      if (session === null || isDemo()) return { outcome: 'locked' };
      const key = parseDraftId(draftId)?.key;
      if (key === undefined) return { outcome: 'absent' };
      if (key === draftRef.current?.draftKey) return { outcome: 'busy' };
      return dropDraft(session.store, key, ({ deleteDraft }) =>
        deleteDraft(session.store, draftId, Date.now()),
      );
    },
    [dropDraft],
  );

  const watchOpenSession = useCallback(() => watchSession(sessionGeneration), []);

  /** Uploads one file of a compose, and says how it went on its chip while that compose is open. */
  const startUpload = useCallback(
    (compose: Compose, { id, content }: DraftFile) => {
      const files = sessionRef.current?.files;
      const isCurrent = watchSession(sessionGeneration);
      const uploading = (async (): Promise<DraftFile['upload']> => {
        if (files === undefined || content === undefined) return 'failed';
        // Something the person asked for, whose bytes a reload would lose. Counted across a lock too.
        const end = activity.begin({ effect: 'write', priority: 'user' });
        try {
          await files.put(id, content);
          return 'uploaded';
        } catch (error) {
          return error instanceof VaultApiError && error.code === 'STORAGE_FULL'
            ? 'storage-full'
            : 'failed';
        } finally {
          end();
        }
      })();
      compose.uploads.set(id, uploading);
      void (async () => {
        const upload = await uploading;
        if (!isCurrent() || composeRef.current !== compose) return;
        setDraft(current =>
          current === null
            ? current
            : {
                ...current,
                attachments: current.attachments.map(file =>
                  file.id === id ? { ...file, upload } : file,
                ),
              },
        );
      })();
    },
    [activity],
  );

  const readStoredFile = useCallback<ComposerShared['readStoredFile']>(
    async fileId => (await sessionRef.current?.files.get(fileId)) ?? null,
    [],
  );

  const shared = useMemo<ComposerShared>(
    () => ({
      drafts,
      sentCopyError,
      writeDraft,
      removeDraft,
      watchSession: watchOpenSession,
      readStoredFile,
    }),
    [drafts, sentCopyError, writeDraft, removeDraft, watchOpenSession, readStoredFile],
  );

  const composer = useMemo<Composer>(
    () => ({
      draft,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      isOpenDraftFrozen,
      sendAgain,
      backToEditing,
      seedDraft: (intent, seed) => {
        const userId = userIdRef.current;
        if (intent === undefined) {
          // Closing keeps the draft (see DECISIONS.md, 2026-08-31). A draft inside the debounce is
          // flushed here; a draft nobody typed into is dropped instead of filed.
          const open = draftRef.current;
          const session = sessionRef.current;
          const compose = composeRef.current;
          composeRef.current = null;
          setDraft(null);
          if (
            open === null ||
            compose === null ||
            session === null ||
            demo ||
            compose.isDiscarded
          ) {
            if (userId !== null) clearDraft(userId);
            return null;
          }
          // Pressing Send is meaning to keep it.
          const abandonable =
            compose.sending === null &&
            compose.isFresh &&
            draftKeyOfIntent(compose.intent) === null &&
            isUntouched(open, compose.opened);
          if (!abandonable) {
            // `setDraft(null)` cancelled the pending debounce, so a record existing is not evidence it holds this text.
            const content = contentOf(open, ownerAccountOf(open));
            const saved = openHandleRef.current;
            if (
              saved !== null &&
              saved.draftId === open.draftId &&
              sameDraftContent(saved.record, content) &&
              !open.attachments.some(({ upload }) => upload === 'uploading')
            ) {
              // The vault already holds exactly this.
              if (userId !== null) clearDraft(userId);
              return null;
            }
            const isCurrent = watchSession(sessionGeneration);
            void (async () => {
              // A Send's claim writes the newest text itself; only a refused one leaves it to file.
              const claimed = await compose.sending;
              if (!isCurrent()) return;
              if (claimed?.ok === true) {
                // ponytail: the snapshot is per user, so this also clears one a compose opened since
                // wrote (DECISIONS.md, 2026-10-09).
                if (userId !== null) clearDraft(userId);
                return;
              }
              // An autosave is replacing the record with possibly older text; the snapshot stays.
              // One still minting it is shared, and this writes over what it mints.
              if (compose.saving !== null && open.draftId !== undefined) return;
              // A file still uploading is one the person attached, so it is worth the wait.
              const attachments = await withUploadsSettled(compose, open.attachments);
              const vault = await import('@yozz.app/mail/compose/draft-vault');
              if (!isCurrent()) return;
              const outcome = await writeContent(
                vault,
                compose,
                isCurrent,
                session.store,
                open.draftId,
                contentOf({ ...open, attachments }, ownerAccountOf(open)),
              );
              if (!isCurrent()) return;
              if (!outcome.ok) {
                // The snapshot is the only copy left, so it stays.
                setDraftError(unsavedMessage);
                return;
              }
              const live = await vault.listDrafts(session.store);
              if (!isCurrent()) return;
              setDrafts(live);
              if (userId !== null) clearDraft(userId);
            })();
            return null;
          }
          if (userId !== null) clearDraft(userId);
          // Nothing was written into it, so the autosaved record is mail nobody meant to keep.
          if (open.draftId === undefined) return null;
          const abandoned = open.draftId;
          const isCurrent = watchSession(sessionGeneration);
          const runOn = bindRunOn();
          void (async () => {
            const { deleteDraft } = await import('@yozz.app/mail/compose/draft-vault');
            if (!isCurrent()) return;
            const gone = await deleteDraft(session.store, abandoned, Date.now());
            // Refused means another device wrote since.
            if (gone.outcome !== 'deleted' || !isCurrent()) return;
            void expungeMirrorCopy(session.store, runOn, open.draftKey ?? '');
            setDrafts(current => current.filter(candidate => candidate.draftKey !== open.draftKey));
          })();
          return null;
        }
        // A `draft:` intent opens a record, never creates one.
        const draftKey = draftKeyOfIntent(intent);
        if (draftKey !== null) {
          const handle = draftsRef.current.find(candidate => candidate.draftKey === draftKey);
          if (handle === undefined) {
            composeRef.current = null;
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
            attachments: (record.attachments ?? []).map(draftFileOf),
            ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
            ...(record.references === undefined ? {} : { references: record.references }),
            draftKey: handle.draftKey,
            draftId: handle.draftId,
            ...(record.ownerAccount === undefined ? {} : { ownerAccount: record.ownerAccount }),
          };
          composeRef.current = composeOf(intent, opened, false);
          setDraft(opened);
          return opened;
        }

        // A restored snapshot knows which record it is; a live handle for the same key wins.
        // ponytail: one restored while its Send is still minting becomes a second record
        // (DECISIONS.md, 2026-10-09).
        const restored = userId === null ? null : loadDraft(userId, intent);
        const live =
          restored?.draftKey === undefined
            ? undefined
            : draftsRef.current.find(candidate => candidate.draftKey === restored.draftKey);
        const stored =
          restored === null || live === undefined
            ? restored
            : { ...restored, draftId: live.draftId };
        const { attachments: seeded = [], ...merged } = seed;
        const next: ComposeDraft = stored ?? {
          // The intent's seed says whether a quoted original opened with it, not the agent's text.
          startedAsReply: seed.body !== undefined && seed.body !== '',
          to: '',
          cc: '',
          bcc: '',
          subject: '',
          body: '',
          attachments: seeded.map(file => draftFileOfSeed(file, demo)),
          ...merged,
          // Resolved last: an identity can be deleted, and a seed may pass `undefined`.
          identityId: merged.identityId ?? identities[0]?.address ?? '',
        };
        const opening = composeOf(intent, next, stored === null);
        composeRef.current = opening;
        setDraft(next);
        for (const file of next.attachments) {
          if (file.upload === 'uploading') startUpload(opening, file);
        }
        return next;
      },
      updateDraft: changes =>
        setDraft(current => (current === null ? current : { ...current, ...changes })),
      discardDraft: async () => {
        // Read before anything awaits: closing follows immediately and clears both.
        const open = draftRef.current;
        const session = sessionRef.current;
        const userId = userIdRef.current;
        // The close that follows must not file what this just threw away.
        const compose = composeRef.current;
        if (compose !== null) compose.isDiscarded = true;
        if (userId !== null) clearDraft(userId);
        const { draftKey, draftId } = open ?? {};
        // ponytail: discarded inside its first autosave's round trip, a draft keeps the record that
        // save mints; it lists in Drafts and discards from there.
        if (open === null || draftKey === undefined || draftId === undefined) {
          return { outcome: 'absent' };
        }
        if (session === null || demo) return { outcome: 'absent' };
        const onScreen = contentOf(open, ownerAccountOf(open));
        return dropDraft(
          session.store,
          draftKey,
          async ({ deleteDraft, listDrafts }, isCurrent) => {
            const outcome = await deleteDraft(session.store, draftId, Date.now());
            if (outcome.outcome !== 'conflict') return outcome;
            // This tab's own autosave can land first. A newer version holding exactly the text on
            // screen is still what the person discarded; any other is another device's writing.
            const newer = (await listDrafts(session.store)).find(
              candidate => candidate.draftId === outcome.currentDraftId,
            );
            return newer !== undefined && isCurrent() && sameDraftContent(newer.record, onScreen)
              ? deleteDraft(session.store, newer.draftId, Date.now())
              : outcome;
          },
        );
      },
      send,
      attach: added => {
        const compose = composeRef.current;
        if (compose === null) return;
        const files = added.map(file => draftFileOfSeed(file, demo));
        setDraft(current =>
          current === null
            ? current
            : {
                ...current,
                // Same filename twice is a re-pick.
                attachments: [
                  ...current.attachments.filter(a => !added.some(b => b.name === a.name)),
                  ...files,
                ],
              },
        );
        for (const file of files) {
          if (file.upload === 'uploading') startUpload(compose, file);
        }
      },
      // The record that named it may come back with another device's version, so R2 keeps it;
      // once nothing names it, collection takes it.
      detach: fileId =>
        setDraft(current =>
          current === null
            ? current
            : { ...current, attachments: current.attachments.filter(a => a.id !== fileId) },
        ),
      retryUpload: fileId => {
        const compose = composeRef.current;
        const failed = draftRef.current?.attachments.find(({ id }) => id === fileId);
        if (compose === null || failed === undefined) return;
        const retried: DraftFile = { ...failed, id: crypto.randomUUID(), upload: 'uploading' };
        setDraft(current =>
          current === null
            ? current
            : {
                ...current,
                attachments: current.attachments.map(file => (file.id === fileId ? retried : file)),
              },
        );
        startUpload(compose, retried);
      },
    }),
    [
      draft,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      isOpenDraftFrozen,
      sendAgain,
      backToEditing,
      send,
      demo,
      identities,
      bindRunOn,
      expungeMirrorCopy,
      ownerAccountOf,
      dropDraft,
      writeContent,
      startUpload,
    ],
  );

  // One list for the thread graph: either kind collapses into a server copy by fingerprint.
  const sentHere = useMemo(() => [...vaultSent, ...justSent], [vaultSent, justSent]);

  return { composer, shared, load, reset, vaultSent: sentHere };
};
