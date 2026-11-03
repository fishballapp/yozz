import type { MailConnectionFailure, Result } from '../connection.ts';
import type { RecordStore } from '../vault/record-store.ts';
import type { DraftRecord, FrozenMessage } from './draft-record.ts';
import {
  advanceSend,
  completeSend,
  type DraftHandle,
  keepSendLease,
  reclaimSend,
  releaseSend,
} from './draft-vault.ts';
import {
  assembleMessage,
  isUnconfirmedSubmission,
  type ReadFile,
  type SentCopyFailure,
} from './send.ts';

/**
 * Each phase is written before the step it names, so a crash repeats a step that finds its own
 * earlier attempt: (0) `submitting` claim, (1) SMTP submit, (2) Sent copy, (3) tombstone the draft,
 * (4) expunge the IMAP mirror. Only `submitting` is ambiguous, so it is never resumed
 * automatically; a submission whose answer was lost moves to `unconfirmed`, which only the person
 * settles. A lease that lapses sends nothing: it only lets a person decide.
 */

type Send = NonNullable<DraftRecord['send']>;
export type SendTarget = NonNullable<Send['target']>;

/** Where the Sent copy landed. */
export type SentLocator = NonNullable<Send['locator']>;

export type SendEffects = {
  readonly store: RecordStore;
  /** A frozen message's file: bytes this device already holds first, R2 otherwise. */
  readonly readFile: ReadFile;
  /** SMTP submit of exactly these bytes. A failure after the end of `DATA` must say so (`isUnconfirmedSubmission`). */
  readonly submit: (
    bytes: Uint8Array,
    handle: DraftHandle,
  ) => Promise<Result<void, MailConnectionFailure>>;
  /**
   * Phase (2). Idempotent by contract: it looks for its own earlier copy first. `null` means no
   * locator to report. `assemble` reads the files, which a copy in the vault needs no bytes of.
   */
  readonly copyToSent: (
    target: SendTarget,
    frozen: {
      readonly message: FrozenMessage;
      readonly assemble: () => Promise<Result<Uint8Array, MailConnectionFailure>>;
    },
    handle: DraftHandle,
  ) => Promise<Result<SentLocator | null, SentCopyFailure>>;
  /** Phase (4). Best effort: the mirror task retries whatever this leaves behind. */
  readonly expungeMirror: (handle: DraftHandle) => Promise<void>;
  readonly now: () => number;
};

export type SendProgress =
  /** The draft is a tombstone that remembers what it became. With no Sent folder it has no copy, and no retry could give it one. */
  | {
      readonly done: true;
      readonly sentCopy: Result<void, Extract<SentCopyFailure, { kind: 'no-sent-mailbox' }>>;
    }
  /** SMTP refused it before the end of `DATA`, or a file could not be read for it: the claim is lifted. */
  | {
      readonly done: false;
      readonly reason: 'refused';
      readonly error: MailConnectionFailure;
      /** A file could not be read, so the same draft may well send once it can. */
      readonly isFileUnreadable: boolean;
    }
  /** It went out, the copy did not; the next unlock retries the copy. */
  | { readonly done: false; readonly reason: 'copy-pending'; readonly error: MailConnectionFailure }
  /** The record moved on without us, or carries no message to resume from. */
  | { readonly done: false; readonly reason: 'abandoned' }
  /** SMTP's answer to phase (1) was lost (the record says `unconfirmed`), or never recorded (it still says `submitting`). */
  | { readonly done: false; readonly reason: 'unconfirmed' };

/** The phase a listed draft is stuck in, if any. */
export const sendPhaseOf = (record: DraftRecord): Send['state'] | null =>
  record.send?.state ?? null;

const runSend = async (effects: SendEffects, claimed: DraftHandle): Promise<SendProgress> => {
  let handle = claimed;
  const send = handle.record.send;
  if (send === undefined) return { done: false, reason: 'abandoned' };
  if (send.message === undefined || send.target === undefined) {
    // A claim with nothing to resume from: another build's, or a device that died before storing it.
    await releaseSend(effects.store, handle.draftId);
    return { done: false, reason: 'abandoned' };
  }
  // Only the person, or the message turning up in Sent, settles a lost answer.
  if (send.state === 'unconfirmed') return { done: false, reason: 'unconfirmed' };
  const { message, target } = send;
  // Files are read once, and only by a step that needs them: `copied` has nothing left to send.
  let assembling: ReturnType<typeof assembleMessage> | undefined;
  const assemble = () => {
    assembling ??= assembleMessage(
      message,
      effects.readFile,
      fileId =>
        handle.record.attachments?.find(({ id }) => id === fileId)?.name ?? 'an attached file',
    );
    return assembling;
  };

  if (send.state === 'submitting') {
    const assembled = await assemble();
    if (!assembled.ok) {
      // Nothing was written to SMTP, so this is a refusal: the person gets their draft back.
      await releaseSend(effects.store, handle.draftId);
      return { done: false, reason: 'refused', error: assembled.error, isFileUnreadable: true };
    }
    const submitted = await effects.submit(assembled.value, handle);
    // The server may hold it: recorded as such at once, so every device offers to settle it.
    if (!submitted.ok && isUnconfirmedSubmission(submitted.error)) {
      await advanceSend(effects.store, handle.draftId, { ...send, state: 'unconfirmed' });
      return { done: false, reason: 'unconfirmed' };
    }
    if (!submitted.ok) {
      // Nothing went out, so the person should have their draft back.
      await releaseSend(effects.store, handle.draftId);
      return { done: false, reason: 'refused', error: submitted.error, isFileUnreadable: false };
    }
    const advanced = await advanceSend(effects.store, handle.draftId, {
      ...send,
      state: 'submitted',
    });
    // Out, but the record still says `submitting`, so the next unlock asks rather than guesses.
    if (advanced === null) return { done: false, reason: 'unconfirmed' };
    handle = advanced;
  }

  const held = handle.record.send;
  if (held?.state === 'submitted') {
    const copied = await effects.copyToSent(target, { message, assemble }, handle);
    if (!copied.ok) {
      if (copied.error.kind === 'no-sent-mailbox') {
        // Not `copied`: there is no copy, and a crash here only asks the same question again.
        await completeSend(effects.store, handle.draftId, send.messageId, effects.now(), {
          isSentWithoutCopy: true,
        });
        await effects.expungeMirror(handle);
        return { done: true, sentCopy: { ok: false, error: copied.error } };
      }
      // Only the copy is missing; phase (2) re-runs and finds its own copy if one landed. Nobody is
      // running it now, so the next run need not wait out this claim: it is dated back to let go.
      await advanceSend(effects.store, handle.draftId, { ...held, claimedAt: 0 }).catch(() => null);
      return { done: false, reason: 'copy-pending', error: copied.error };
    }
    const advanced = await advanceSend(effects.store, handle.draftId, {
      ...held,
      state: 'copied',
      ...(copied.value === null ? {} : { locator: copied.value }),
    });
    if (advanced === null) return { done: false, reason: 'abandoned' };
    handle = advanced;
  }

  await completeSend(effects.store, handle.draftId, send.messageId, effects.now());
  await effects.expungeMirror(handle);
  return { done: true, sentCopy: { ok: true, value: undefined } };
};

/**
 * Everything after a claim, for a fresh send and a resumed one alike: `claimed` was just written by
 * `claimSend` or `reclaimSend`. Its lease is renewed for as long as this runs, however it ends.
 */
export const driveSend = async (
  effects: SendEffects,
  claimed: DraftHandle,
): Promise<SendProgress> => {
  const { send } = claimed.record;
  if (send === undefined) return { done: false, reason: 'abandoned' };
  const stopRenewing = keepSendLease(effects.store, send.opId, effects.now);
  try {
    return await runSend(effects, claimed);
  } finally {
    await stopRenewing();
  }
};

/**
 * Finishes every send SMTP accepted and nobody is running any more. `submitting` and `unconfirmed`
 * are skipped: a duplicate is not a background task's decision. One still running, a tab reloaded a
 * moment ago included, is left to the unlock after its lease ends.
 */
export const resumeSends = async (
  drafts: readonly DraftHandle[],
  effectsFor: (handle: DraftHandle) => SendEffects | null,
): Promise<void> => {
  for (const handle of drafts) {
    const state = handle.record.send?.state;
    if (state !== 'submitted' && state !== 'copied') continue;
    const effects = effectsFor(handle);
    if (effects === null) continue;
    const reclaimed = await reclaimSend(effects.store, handle.draftId, effects.now());
    if (reclaimed !== null) await driveSend(effects, reclaimed);
  }
};
