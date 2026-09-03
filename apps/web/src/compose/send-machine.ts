import type { MailConnectionFailure, Result } from '../relay/connection';
import type { RecordStore } from '../vault/record-store';
import type { DraftRecord } from './draft-record';
import { advanceSend, completeSend, type DraftHandle, releaseSend } from './draft-vault';
import type { SentCopyFailure } from './send';

/**
 * Each phase is written before the step it names, so a crash repeats a step that finds its own
 * earlier attempt:
 *
 *   (0) `submitting`  the claim: content frozen on every device, bytes and target stored
 *   (1) SMTP submit of exactly those bytes → `submitted`
 *   (2) the Sent copy (IMAP APPEND, or a vault record) → `copied`
 *   (3) tombstone the draft with what it became
 *   (4) expunge the IMAP mirror of the draft
 *
 * Only `submitting` is ambiguous, so it is never resumed automatically.
 */

type Send = NonNullable<DraftRecord['send']>;
export type SendTarget = NonNullable<Send['target']>;

/** Where the Sent copy landed. */
export type SentLocator = NonNullable<Send['locator']>;

export type SendEffects = {
  readonly store: RecordStore;
  /** SMTP submit of exactly these bytes. */
  readonly submit: (
    bytes: Uint8Array,
    handle: DraftHandle,
  ) => Promise<Result<void, MailConnectionFailure>>;
  /** Phase (2). Idempotent by contract: it looks for its own earlier copy first. `null` means no locator to report. */
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
  /** The draft is a tombstone that remembers what it became. */
  | { readonly done: true; readonly sentCopy: Result<void, SentCopyFailure> }
  /** SMTP refused it: the claim is lifted. */
  | { readonly done: false; readonly reason: 'refused'; readonly error: MailConnectionFailure }
  /** It went out, the copy did not; the next unlock retries the copy. */
  | { readonly done: false; readonly reason: 'copy-pending'; readonly error: SentCopyFailure }
  /** The record moved on without us, or carries no bytes to resume from. */
  | { readonly done: false; readonly reason: 'abandoned' }
  /** SMTP's answer to phase (1) was never seen. */
  | { readonly done: false; readonly reason: 'unconfirmed' };

/** The phase a listed draft is stuck in, if any. */
export const sendPhaseOf = (record: DraftRecord): Send['state'] | null =>
  record.send?.state ?? null;

/** Everything after `claimSend`, for a fresh send and a resumed one alike. */
export const driveSend = async (
  effects: SendEffects,
  claimed: DraftHandle,
): Promise<SendProgress> => {
  let handle = claimed;
  const send = handle.record.send;
  if (send === undefined) return { done: false, reason: 'abandoned' };
  if (send.bytes === undefined || send.target === undefined) {
    // A claim with nothing to resume from: an older build, or a device that died before storing the bytes.
    await releaseSend(effects.store, handle.draftId);
    return { done: false, reason: 'abandoned' };
  }
  const bytes = Uint8Array.fromBase64(send.bytes);
  const target = send.target;

  if (send.state === 'submitting') {
    const submitted = await effects.submit(bytes, handle);
    if (!submitted.ok) {
      // Nothing went out, so the person should have their draft back.
      await releaseSend(effects.store, handle.draftId);
      return { done: false, reason: 'refused', error: submitted.error };
    }
    const advanced = await advanceSend(effects.store, handle.draftId, {
      ...send,
      state: 'submitted',
    });
    // Out, but the record still says `submitting`, so the next unlock asks rather than guesses.
    if (advanced === null) return { done: false, reason: 'unconfirmed' };
    handle = advanced;
  }

  if (handle.record.send?.state === 'submitted') {
    const copied = await effects.copyToSent(target, bytes, handle);
    if (!copied.ok) {
      // Only the copy is missing; phase (2) re-runs and finds its own copy if one landed.
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

/** Finishes every send left in flight. `submitting` is skipped: a duplicate is not a background task's decision. */
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
