import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AddressRecord, type InboundAddress, isInbound } from '../addresses/record';
import {
  addressList,
  type ComposeDraft,
  contentOf,
  type DraftContent,
  ownerAccountFor,
  type SendReport,
  sameDraftContent,
} from '../compose/draft';
import { clearDraft, loadDraft, saveDraft } from '../compose/draft-device';
import { openSendStateOf, parseDraftId } from '../compose/draft-record';
import type { DeleteOutcome, DraftHandle, SaveOutcome } from '../compose/draft-vault';
import { type ComposeIntent, draftKeyOfIntent, isUntouched } from '../compose/intent';
import type { SendEffects } from '../compose/send-machine';
import type { SentRecord } from '../compose/sent-record';
import type { MailConnectionFailure, Result } from '../relay/connection';
import { describeMailFailure } from '../relay/describe-failure';
import type { RunOn } from '../relay/live';
import type { AccountSummaries, VaultSentMessage } from '../threads/summaries';
import type { Attachment, ThreadState } from '../threads/thread';
import { isDemo } from '../ui/chrome';
import type { RecordStore } from '../vault/record-store';
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
  error: { kind: 'error', detail: 'The vault is locked.' },
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
  /** An autosave is writing; one at a time, since each names the version it read. */
  isSaving: boolean;
  /** The latest Send, from its press: its claim writes the newest text itself, so the closing flush waits for it. */
  sending: Promise<SendClaim> | null;
};

const composeOf = (intent: ComposeIntent, opened: ComposeDraft, isFresh: boolean): Compose => ({
  intent,
  opened,
  isFresh,
  isDiscarded: false,
  minting: null,
  isSaving: false,
  sending: null,
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
  /** Re-runs the unconfirmed send with the same bytes. */
  sendAgain: () => Promise<void>;
  /** Puts the unconfirmed send aside so the draft can be written again. Discard stays refused. */
  backToEditing: () => Promise<void>;
  /**
   * `?compose=` decides whether the composer is on screen; this follows it. A device-stored draft
   * for the same intent wins over the seed.
   */
  seedDraft: (
    intent: ComposeIntent | undefined,
    seed: Partial<ComposeDraft>,
  ) => ComposeDraft | null;
  updateDraft: (changes: Partial<ComposeDraft>) => void;
  /**
   * Throws the open draft away before anything awaits, so the caller closes the composer straight
   * after; the promise is the vault's answer, which arrives with the composer gone.
   */
  discardDraft: () => Promise<DeleteOutcome | SessionEnded>;
  /**
   * Sends the draft over its identity's SMTP. Resolves at the claim, where the bytes are frozen
   * into the record; a refusal before then is an error the composer shows, and everything after is
   * reported through `settled`. A send claimed as its session ends still goes out, and settles as
   * `ended`.
   */
  send: () => Promise<Result<{ readonly settled: Promise<SendReport> }, MailConnectionFailure>>;
  attach: (attachments: readonly Attachment[]) => void;
  detach: (name: string) => void;
};

export const useComposerStore = ({
  session,
  identities,
  accounts,
  bindRunOn,
  sync,
  threadsRef,
  baseByAccount,
  demo,
}: {
  session: ReturnType<typeof useVault>['session'];
  identities: readonly AddressRecord[];
  accounts: readonly InboundAddress[];
  /**
   * The IMAP runner of the session open now, refusing every task once that session has ended.
   * Taken with `watchSession`, before the first await, and carried through the work it starts.
   */
  bindRunOn: () => RunOn;
  sync: (address?: string) => Promise<void>;
  /** The threads as rendered; read by the draft writes, which run outside a render. */
  threadsRef: RefObject<readonly ThreadState[]>;
  baseByAccount: AccountSummaries;
  demo: boolean;
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
      { createDraft, replaceDraft }: typeof import('../compose/draft-vault'),
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
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

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
        import('../compose/draft-vault'),
        import('../compose/draft-mirror'),
      ]);
      const mirror = await readMirror(store, draftKey);
      const account = accountsRef.current.find(
        candidate => candidate.address === mirror?.mirror.locator?.account,
      );
      if (account === undefined) return;
      await expungeMirror(runOn(account), store, draftKey);
    },
    [],
  );

  /** One implementation of each phase for a live send and a resumed one, in the session it began in. */
  const sendEffectsFor = useCallback(
    (store: RecordStore, runOn: RunOn, identity: AddressRecord): SendEffects => ({
      store,
      submit: async (bytes, handle) => {
        const { envelopeRecipients, submitBytes } = await import('../compose/send');
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
          const { sentRecordFrom, storeSentRecord } = await import('../compose/sent-vault');
          await storeSentRecord(store, sentRecordFrom(handle.record, messageId, bytes, Date.now()));
          return { ok: true, value: null };
        }
        const { storeSentCopy } = await import('../compose/send');
        const copied = await storeSentCopy(runOn(identity), bytes, messageId);
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
    [expungeMirrorCopy],
  );

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

  /**
   * The half of a send only the network can settle. Runs with the composer already closed, and
   * answers to the session the send began in (`isCurrent`), which may have ended by the claim.
   */
  const settleSend = useCallback(
    async (
      store: RecordStore,
      runOn: RunOn,
      identity: AddressRecord,
      handle: DraftHandle,
      isCurrent: () => boolean,
    ): Promise<SendReport> => {
      // Counted across a lock too: the send is on the network either way.
      setSendsInFlight(count => count + 1);
      try {
        const [{ driveSend }, { listSentRecords, sentRecordFrom }] = await Promise.all([
          import('../compose/send-machine'),
          import('../compose/sent-vault'),
        ]);
        const progress = await driveSend(sendEffectsFor(store, runOn, identity), handle);
        if (!isCurrent()) return { state: 'ended' };
        // SMTP refused the message; the account's IMAP host is where the Sent copy was going.
        const smtpHost = identity.smtp.host;
        const imapHost = identity.imap?.host ?? identity.address;
        const dropSent = (current: readonly DraftHandle[]) =>
          current.filter(candidate => candidate.draftKey !== handle.draftKey);
        // Shown before Drafts lets go of it, so no render has the message in neither.
        const showSent = () => {
          const { send } = handle.record;
          if (send?.bytes === undefined) return;
          const { bytes: _bytes, ...message } = sentRecordFrom(
            handle.record,
            send.messageId,
            Uint8Array.fromBase64(send.bytes),
            Date.now(),
          );
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
          const { listDrafts } = await import('../compose/draft-vault');
          const live = await listDrafts(store);
          if (!isCurrent()) return { state: 'ended' };
          setDrafts(live);
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
          // It went out, and until the next unlock retries the copy, this tab's is the only one.
          if (isInbound(identity)) showSent();
          setDrafts(dropSent);
          return { state: 'sent-with-caveat', detail };
        }
        // Nobody saw SMTP's answer, so "Sent" would be invented. The draft stays listed with its phase.
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
        setSendsInFlight(count => count - 1);
      }
    },
    [sync, sendEffectsFor],
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
    async (compose: Compose, draft: ComposeDraft): Promise<SendClaim> => {
      const identity = identities.find(candidate => candidate.address === draft.identityId);
      const messageId = `<${crypto.randomUUID()}@${draft.identityId.slice(draft.identityId.indexOf('@') + 1)}>`;

      if (!isDemo()) {
        if (identity === undefined) {
          return { ok: false, error: { kind: 'error', detail: 'Pick an address to send as.' } };
        }
        const session = sessionRef.current;
        if (session === null) return lockedBeforeSend;
        // Taken before the first await and carried into the settling, which may outlive the session.
        const isCurrent = watchSession(sessionGeneration);
        const runOn = bindRunOn();
        clearTimeout(autosaveTimerRef.current);
        const content = contentOf(draft, ownerAccountOf(draft));
        const [{ claimSend, createDraft }, { buildOutgoing }, { renderHtml }] = await Promise.all([
          import('../compose/draft-vault'),
          import('../compose/send'),
          import('@tanstack/markdown/html'),
        ]);
        // An ended session mints and claims nothing, so nothing goes out on its behalf.
        if (!isCurrent()) return lockedBeforeSend;
        // Every send owns a record. A compose sent inside the debounce has none yet; minting it here
        // makes a crash resumable and stops a second device sending its own copy.
        const draftId = await (async () => {
          if (draft.draftId !== undefined) return draft.draftId;
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
          value: { settled: settleSend(session.store, runOn, identity, claimed.handle, isCurrent) },
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
    // Held before anything awaits, so a close under way waits for the claim.
    compose.sending = sendCompose(compose, draft);
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
        const [
          { draftMirrorMessageId, mirrorAccountOf, mirrorDraft },
          { buildOutgoing },
          { renderHtml },
        ] = await Promise.all([
          import('../compose/draft-mirror'),
          import('../compose/send'),
          import('@tanstack/markdown/html'),
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
  }, [openHandle, accounts, identities, bindRunOn]);

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
    const isCurrent = watchSession(sessionGeneration);
    void (async () => {
      const { completeSend, listDrafts } = await import('../compose/draft-vault');
      for (const handle of settled) {
        const messageId = handle.record.unconfirmedSend?.messageId;
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
    if (draft.body === '' && draft.subject === '' && draft.to === '') return;
    const pending = draft;
    const timer = setTimeout(() => {
      // One save at a time; a compose closed under the timer is its closing flush's to file.
      if (compose.isSaving || composeRef.current !== compose) return;
      compose.isSaving = true;
      const isCurrent = watchSession(sessionGeneration);
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
          const vault = await import('../compose/draft-vault');
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
          compose.isSaving = false;
        }
      })();
    }, DRAFT_AUTOSAVE_MS);
    autosaveTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [draft, ownerAccountOf, writeContent]);

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
    const isCurrent = watchSession(sessionGeneration);
    const runOn = bindRunOn();
    const [{ reclaimSend }, { driveSend }] = await Promise.all([
      import('../compose/draft-vault'),
      import('../compose/send-machine'),
    ]);
    // As `send`: an ended session claims nothing.
    if (!isCurrent()) return;
    // Already claimed: carry on from the phase the record names.
    const claimed =
      openHandle.record.send === undefined
        ? await reclaimSend(session.store, openHandle.draftId, Date.now())
        : openHandle;
    if (claimed === null) return;
    await driveSend(sendEffectsFor(session.store, runOn, identity), claimed);
    if (!isCurrent()) return;
    const { listDrafts } = await import('../compose/draft-vault');
    const live = await listDrafts(session.store);
    if (isCurrent()) setDrafts(live);
  }, [openHandle, identities, bindRunOn, sendEffectsFor]);

  const backToEditing = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const isCurrent = watchSession(sessionGeneration);
    const { listDrafts, unconfirmSend } = await import('../compose/draft-vault');
    if (!isCurrent()) return;
    await unconfirmSend(session.store, openHandle.draftId);
    const live = await listDrafts(session.store);
    if (isCurrent()) setDrafts(live);
  }, [openHandle]);

  /** The vault's drafts and sent records, then the sends this vault left in flight. */
  const load = useCallback(
    async (store: RecordStore, records: readonly AddressRecord[], isCancelled: () => boolean) => {
      // Before the first await: a send resumed below copies into this session's mailboxes or nowhere.
      const runOn = bindRunOn();
      // Drafts come from the vault too.
      const { listDrafts, purgeExpiredDrafts } = await import('../compose/draft-vault');
      // Before listing, so an expired tombstone stops costing storage.
      await purgeExpiredDrafts(store, Date.now());
      const drafts = await listDrafts(store);
      if (isCancelled()) return;
      setDrafts(drafts);
      const { listSentRecords } = await import('../compose/sent-vault');
      const sent = await listSentRecords(store);
      // An ended session resumes nothing; the next unlock of this vault finds the same phases.
      if (isCancelled()) return;
      setVaultSent(sent);
      // A send this vault left in flight is finished before anything else touches the draft;
      // `submitting` is skipped inside `resumeSends`.
      const { resumeSends } = await import('../compose/send-machine');
      if (isCancelled()) return;
      // Asked again before each send: one that ran on finishes, but none starts after a lock.
      await resumeSends(drafts, handle => {
        if (isCancelled()) return null;
        const identity = records.find(record => record.address === handle.record.from);
        return identity === undefined ? null : sendEffectsFor(store, runOn, identity);
      });
      // Checked after the read: one that spans a lock holds this user's drafts.
      const live = await listDrafts(store);
      if (!isCancelled()) setDrafts(live);
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
        vault: typeof import('../compose/draft-vault'),
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
          const vault = await import('../compose/draft-vault');
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
    const { createDraft, listDrafts, replaceDraft } = await import('../compose/draft-vault');
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

  const shared = useMemo<ComposerShared>(
    () => ({ drafts, sentCopyError, writeDraft, removeDraft, watchSession: watchOpenSession }),
    [drafts, sentCopyError, writeDraft, removeDraft, watchOpenSession],
  );

  const composer = useMemo<Composer>(
    () => ({
      draft,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
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
              sameDraftContent(saved.record, content)
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
              if (compose.isSaving && open.draftId !== undefined) return;
              const vault = await import('../compose/draft-vault');
              if (!isCurrent()) return;
              const outcome = await writeContent(
                vault,
                compose,
                isCurrent,
                session.store,
                open.draftId,
                content,
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
            const { deleteDraft } = await import('../compose/draft-vault');
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
            attachments: [],
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
        composeRef.current = composeOf(intent, next, stored === null);
        setDraft(next);
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
    }),
    [
      draft,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
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
    ],
  );

  // One list for the thread graph: either kind collapses into a server copy by fingerprint.
  const sentHere = useMemo(() => [...vaultSent, ...justSent], [vaultSent, justSent]);

  return { composer, shared, load, reset, vaultSent: sentHere };
};
