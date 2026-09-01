import type { DraftRecord } from '../lib/drafts';
import type { RecordStore } from '../vault/record-store';
import type { MailConnectionFailure, Result } from './connection';
import { advanceSend, completeSend, type DraftHandle, releaseSend } from './draft-records';
import type { SentCopyFailure } from './send';

/**
 * A send, as the phases a crash can be resumed from.
 *
 * The record carries the phase, so the question after a reload is never "did this go out?" asked
 * of the network — it is read off the draft. Each phase is written down BEFORE the step it names,
 * so the worst a crash can do is repeat a step that knows how to find its own earlier attempt.
 *
 *   (0) `submitting`  the claim: content frozen on every device, bytes and target stored
 *   (1) SMTP submit of exactly those bytes → `submitted`
 *   (2) the Sent copy (IMAP APPEND, or a vault record) → `copied`
 *   (3) tombstone the draft with what it became
 *   (4) expunge the IMAP mirror of the draft
 *
 * Only `submitting` is ambiguous — nobody knows whether SMTP accepted — so it is the one phase
 * this never resumes on its own. It is shown to the person, who sends again or goes back to
 * editing. Every other phase resumes automatically, because repeating its step is safe.
 */

type Send = NonNullable<DraftRecord['send']>;
export type SendTarget = NonNullable<Send['target']>;

/** Where the Sent copy landed, for the record. */
export type SentLocator = NonNullable<Send['locator']>;

export type SendEffects = {
  readonly store: RecordStore;
  /** SMTP submit of exactly these bytes, to the envelope the draft's own recipients make. */
  readonly submit: (
    bytes: Uint8Array,
    handle: DraftHandle,
  ) => Promise<Result<void, MailConnectionFailure>>;
  /**
   * Phase (2). Idempotent by contract: it looks for its own earlier copy (the message's own
   * Message-ID for IMAP, the record's key for the vault) before writing one. `null` means the copy
   * landed somewhere with no locator to report, which is not a failure.
   */
  readonly copyToSent: (
    target: SendTarget,
    bytes: Uint8Array,
    handle: DraftHandle,
  ) => Promise<Result<SentLocator | null, SentCopyFailure>>;
  /** Phase (4). Best effort: the mirror task retries whatever this leaves behind. */
  readonly expungeMirror: (handle: DraftHandle) => Promise<void>;
  readonly now: () => number;
};

export type SendProgress =
  /** The message went out and the draft is a tombstone that remembers what it became. */
  | { readonly done: true; readonly sentCopy: Result<void, SentCopyFailure> }
  /** SMTP refused it: nothing went out, the claim is lifted, the draft is editable again. */
  | { readonly done: false; readonly reason: 'refused'; readonly error: MailConnectionFailure }
  /** It went out, the copy did not. The draft stays frozen and the next unlock retries the copy. */
  | { readonly done: false; readonly reason: 'copy-pending'; readonly error: SentCopyFailure }
  /** The record moved on without us, or carries no bytes to resume from. Nothing was written. */
  | { readonly done: false; readonly reason: 'abandoned' }
  /** Awaiting the person: SMTP's answer to phase (1) was never seen. */
  | { readonly done: false; readonly reason: 'unconfirmed' };

/** The phase a listed draft is stuck in, if any — what the unlock sweep and the composer read. */
export const sendPhaseOf = (record: DraftRecord): Send['state'] | null =>
  record.send?.state ?? null;

/**
 * Drives a claimed send to the end, from whatever phase its record is in.
 *
 * The caller has already written phase (0) with `claimSend`; this is everything after it, and it
 * is the same code path for a fresh send and for one a reload picked up.
 */
export const driveSend = async (
  effects: SendEffects,
  claimed: DraftHandle,
): Promise<SendProgress> => {
  let handle = claimed;
  const send = handle.record.send;
  if (send === undefined) return { done: false, reason: 'abandoned' };
  if (send.bytes === undefined || send.target === undefined) {
    // A claim with nothing to resume from: written by a build older than this machine, or by a
    // device that died between claiming and storing the bytes. Freeing it beats freezing it.
    await releaseSend(effects.store, handle.draftId);
    return { done: false, reason: 'abandoned' };
  }
  const bytes = Uint8Array.fromBase64(send.bytes);
  const target = send.target;

  if (send.state === 'submitting') {
    const submitted = await effects.submit(bytes, handle);
    if (!submitted.ok) {
      // SMTP refused: nothing went out, so the frozen bytes are worth nothing and the person
      // should have their draft back.
      await releaseSend(effects.store, handle.draftId);
      return { done: false, reason: 'refused', error: submitted.error };
    }
    const advanced = await advanceSend(effects.store, handle.draftId, {
      ...send,
      state: 'submitted',
    });
    // The message is out but the record still says `submitting`, so the next unlock asks rather
    // than guessing. That is the ambiguity this phase exists to name, not a bug to paper over.
    if (advanced === null) return { done: false, reason: 'unconfirmed' };
    handle = advanced;
  }

  if (handle.record.send?.state === 'submitted') {
    const copied = await effects.copyToSent(target, bytes, handle);
    if (!copied.ok) {
      // The message is gone; only the copy is missing. The draft stays frozen at `submitted` and
      // the next unlock runs phase (2) again, which finds its own copy if one did land.
      return { done: false, reason: 'copy-pending', error: copied.error };
    }
    const advanced = await advanceSend(effects.store, handle.draftId, {
      ...send,
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
 * The unlock sweep: finishes every send this vault left in flight.
 *
 * `submitting` is skipped on purpose — resuming it would resend a message that may already have
 * gone out, and a duplicate at the recipient is not a decision a background task gets to make.
 */
export const resumeSends = async (
  drafts: readonly DraftHandle[],
  effectsFor: (handle: DraftHandle) => SendEffects | null,
): Promise<void> => {
  for (const handle of drafts) {
    if (handle.record.send === undefined || handle.record.send.state === 'submitting') continue;
    const effects = effectsFor(handle);
    if (effects === null) continue;
    await driveSend(effects, handle);
  }
};
