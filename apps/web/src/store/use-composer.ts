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
import type { LiveTask } from '../relay/live';
import type { AccountSummaries } from '../threads/summaries';
import type { Attachment, ThreadState } from '../threads/thread';
import { isDemo } from '../ui/chrome';
import type { RecordStore } from '../vault/record-store';
import type { useVault } from '../vault/session';

/**
 * The composer's half of the store: the open draft, every draft in the vault, and sending. The
 * mailbox half hands it the accounts, the live connections and the threads; it hands back the
 * slice `useMail` exposes plus the load and reset the session effect calls.
 */

/** Autosave debounce after the last keystroke. */
const DRAFT_AUTOSAVE_MS = 2_000;

/** How long a draft sits still before its IMAP copy is refreshed; longer than the autosave on purpose. */
const DRAFT_MIRROR_MS = 10_000;

/** What the composer says while the newest text has not reached the vault. */
const unsavedMessage = 'Not saved to your account yet — check your connection.';

export type Composer = {
  draft: ComposeDraft | null;
  /** A send whose Sent-folder copy did not store; cleared by the next send that does. */
  sentCopyError: string | null;
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
  attach: (attachments: readonly Attachment[]) => void;
  detach: (name: string) => void;
};

export const useComposer = ({
  session,
  identities,
  accounts,
  runOn,
  sync,
  threadsRef,
  baseByAccount,
  demo,
}: {
  session: ReturnType<typeof useVault>['session'];
  identities: readonly AddressRecord[];
  accounts: readonly InboundAddress[];
  runOn: (
    account: InboundAddress,
  ) => <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;
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
  /** Read by the unlock through a ref, so the unlock stays off the send effects' deps. */
  const sendEffectsRef = useRef<
    ((store: RecordStore, identity: AddressRecord) => SendEffects) | null
  >(null);

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

  /** Erases a draft's IMAP copy wherever the mirror record says it is. */
  const expungeMirrorCopy = useCallback(
    async (draftKey: string) => {
      const session = sessionRef.current;
      if (draftKey === '' || session === null || isDemo()) return;
      const [{ readMirror }, { expungeMirror }] = await Promise.all([
        import('../compose/draft-vault'),
        import('../compose/draft-mirror'),
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
        const { driveSend } = await import('../compose/send-machine');
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
            const { listSentRecords } = await import('../compose/sent-vault');
            setVaultSent(await listSentRecords(store));
          }
          setDrafts(dropSent);
          return { state: 'sent' };
        }
        if (progress.reason === 'refused') {
          // Re-listed first: the claim and its release moved the record on twice, so the handle this
          // device holds is two versions behind and reopening would be refused as a conflict.
          const { listDrafts } = await import('../compose/draft-vault');
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
    [threadsRef],
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
        import('../compose/draft-vault'),
        import('../compose/send'),
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
          import('../compose/draft-mirror'),
          import('../compose/send'),
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
      const { completeSend, listDrafts } = await import('../compose/draft-vault');
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
            const { createDraft } = await import('../compose/draft-vault');
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
          const { replaceDraft } = await import('../compose/draft-vault');
          const outcome = await replaceDraft(session.store, pending.draftId, content, Date.now());
          if (!outcome.ok) {
            if (outcome.reason !== 'conflict') setDraftError(unsavedMessage);
            if (outcome.reason === 'conflict' && outcome.currentDraftId !== null) {
              const { listDrafts } = await import('../compose/draft-vault');
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
      import('../compose/draft-vault'),
      import('../compose/send-machine'),
    ]);
    // Already claimed: carry on from the phase the record names.
    const claimed =
      openHandle.record.send === undefined
        ? await reclaimSend(session.store, openHandle.draftId, Date.now())
        : openHandle;
    if (claimed === null) return;
    await driveSend(sendEffectsFor(session.store, identity), claimed);
    const { listDrafts } = await import('../compose/draft-vault');
    setDrafts(await listDrafts(session.store));
  }, [openHandle, identities, sendEffectsFor]);

  const backToEditing = useCallback(async () => {
    const session = sessionRef.current;
    if (openHandle === null || session === null) return;
    const { listDrafts, unconfirmSend } = await import('../compose/draft-vault');
    await unconfirmSend(session.store, openHandle.draftId);
    setDrafts(await listDrafts(session.store));
  }, [openHandle]);

  /** The vault's drafts and sent records, then the sends this vault left in flight. */
  const load = useCallback(
    async (store: RecordStore, records: readonly AddressRecord[], isCancelled: () => boolean) => {
      // Drafts come from the vault too.
      const { listDrafts, purgeExpiredDrafts } = await import('../compose/draft-vault');
      // Before listing, so an expired tombstone stops costing storage.
      await purgeExpiredDrafts(store, Date.now());
      const drafts = await listDrafts(store);
      if (!isCancelled()) setDrafts(drafts);
      const { listSentRecords } = await import('../compose/sent-vault');
      const sent = await listSentRecords(store);
      if (!isCancelled()) setVaultSent(sent);
      // A send this vault left in flight is finished before anything else touches the draft;
      // `submitting` is skipped inside `resumeSends`.
      const { resumeSends } = await import('../compose/send-machine');
      await resumeSends(drafts, handle => {
        const identity = records.find(record => record.address === handle.record.from);
        const effectsFor = sendEffectsRef.current;
        return identity === undefined || effectsFor === null ? null : effectsFor(store, identity);
      });
      if (!isCancelled()) setDrafts(await listDrafts(store));
    },
    [],
  );

  /** Everything here is this user's plaintext; the provider outlives the session. */
  const reset = useCallback((userId: string) => {
    setVaultSent([]);
    setSentCopyError(null);
    setDraftError(null);
    setDraft(null);
    setDrafts([]);
    setDraftConflict(null);
    clearDraft(userId);
  }, []);

  const slice = useMemo<Composer>(
    () => ({
      draft,
      drafts,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      sendAgain,
      backToEditing,
      sentCopyError,
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
                  '../compose/draft-vault'
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
            const { deleteDraft } = await import('../compose/draft-vault');
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
        const { createDraft, listDrafts, replaceDraft } = await import('../compose/draft-vault');
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
        const { deleteDraft } = await import('../compose/draft-vault');
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
        const { deleteDraft, listDrafts } = await import('../compose/draft-vault');
        const outcome = await deleteDraft(session.store, draftId, Date.now());
        if (outcome.outcome === 'deleted') {
          void expungeMirrorCopy(key ?? '');
          setDrafts(await listDrafts(session.store));
        }
        return outcome;
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
      drafts,
      draftConflict,
      draftError,
      resolveDraftConflict,
      openSendState,
      sendAgain,
      backToEditing,
      sentCopyError,
      send,
      demo,
      identities,
      expungeMirrorCopy,
      ownerAccountOf,
    ],
  );

  return { slice, load, reset, setDrafts, drafts, vaultSent };
};
