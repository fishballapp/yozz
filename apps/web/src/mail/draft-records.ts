import {
  DRAFT_MIRROR_RECORD_TYPE,
  DRAFT_RECORD_TYPE,
  DRAFT_TOMBSTONE_MS,
  type DraftMirrorRecord,
  type DraftRecord,
  draftIdOf,
  heldSend,
  newDraftKey,
  parseDraftId,
  parseDraftMirrorRecord,
  parseDraftRecord,
} from '../lib/drafts';
import { VaultApiError } from '../vault/api';
import type { RecordStore } from '../vault/record-store';

/**
 * Drafts in the vault, under compare-and-swap.
 *
 * Every write states the version it read, so two devices with the same draft open cannot
 * overwrite each other silently: the loser is refused and told the current version, and the
 * person decides. There are no forks and no merge — a mail draft is prose, and a machine merging
 * two versions of prose produces something neither person wrote.
 *
 * Online only, deliberately: `save` awaits the vault PUT, like every vault write today. The
 * offline story is the encrypted local store and write queue that arrive with offline-first, and
 * the key + version model already accommodates them.
 */

export type DraftHandle = {
  readonly draftKey: string;
  readonly draftId: string;
  readonly record: DraftRecord;
};

export type SaveOutcome =
  | { readonly ok: true; readonly handle: DraftHandle }
  /** Someone else's version is current. `currentDraftId` is what a retry must name. */
  | { readonly ok: false; readonly reason: 'conflict'; readonly currentDraftId: string | null }
  /** A send is in flight for this draft on some device; its bytes must not change. */
  | { readonly ok: false; readonly reason: 'sending' }
  | { readonly ok: false; readonly reason: 'offline' };

const isConflict = (error: unknown) => error instanceof VaultApiError && error.code === 'CONFLICT';

/**
 * The id that actually WON, read after a refusal rather than reported from the read that lost.
 *
 * The pre-race id is the caller's own stale one, and a caller told that cannot find the winner to
 * show it — so the conflict banner never appears and the newest text sits only in the editor.
 */
const winnerIdAfterRefusal = async (
  store: RecordStore,
  draftKey: string,
): Promise<string | null> => {
  const now = await readDraft(store, draftKey);
  return now === null ? null : draftIdOf(draftKey, now.record.contentVersion);
};

/** A vault write that failed for any reason other than a refused precondition. */
const isOffline = (error: unknown) => !isConflict(error);

const readDraft = async (
  store: RecordStore,
  draftKey: string,
): Promise<{ record: DraftRecord; revision: number } | null> => {
  const opened = await store.get(DRAFT_RECORD_TYPE, draftKey);
  if (opened === null) return null;
  const record = parseDraftRecord(opened.plaintext);
  return record === null ? null : { record, revision: opened.revision };
};

export const createDraft = async (
  store: RecordStore,
  content: Omit<DraftRecord, 'contentVersion'>,
  now: number,
): Promise<SaveOutcome> => {
  const draftKey = newDraftKey();
  const record: DraftRecord = { ...content, contentVersion: 1, updatedAt: now };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: draftKey,
      plaintext: JSON.stringify(record),
      // There is no row yet, and a key collision is the one thing that would silently take
      // somebody else's draft.
      precondition: { expect: 'absent' },
    });
  } catch (error) {
    if (isConflict(error)) return { ok: false, reason: 'conflict', currentDraftId: null };
    if (isOffline(error)) return { ok: false, reason: 'offline' };
    throw error;
  }
  return { ok: true, handle: { draftKey, draftId: draftIdOf(draftKey, 1), record } };
};

/**
 * A full snapshot, never a patch: the editor holds the whole text, and a field-level patch of
 * prose is a merge by another name. `draftId` names the version this replaces.
 */
export const replaceDraft = async (
  store: RecordStore,
  draftId: string,
  content: Omit<DraftRecord, 'contentVersion' | 'send' | 'sentMessageId' | 'deletedAt'>,
  now: number,
): Promise<SaveOutcome> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const current = await readDraft(store, parsed.key);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const currentId = draftIdOf(parsed.key, current.record.contentVersion);
  // A send in flight freezes the content on every device: the bytes SMTP was handed are the
  // message, and editing them now would make the record disagree with what went out.
  if (heldSend(current.record, now) !== undefined) return { ok: false, reason: 'sending' };
  if (current.record.contentVersion !== parsed.version) {
    return { ok: false, reason: 'conflict', currentDraftId: currentId };
  }
  // Which conversation the draft belongs to is a fact about the draft, not text in the editor:
  // the composer's saves do not carry it, and dropping it would leave the reply to be re-found
  // from `In-Reply-To` alone.
  const threadId = content.threadId ?? current.record.threadId;
  const record: DraftRecord = {
    ...content,
    ...(threadId === undefined ? {} : { threadId }),
    contentVersion: parsed.version + 1,
    updatedAt: now,
    // Editing does not settle an unconfirmed send: that message may be at its recipient, so the
    // bytes and the refusal to discard survive every save until a sync says otherwise.
    ...(current.record.unconfirmedSend === undefined
      ? {}
      : { unconfirmedSend: current.record.unconfirmedSend }),
  };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch (error) {
    if (isConflict(error)) {
      return {
        ok: false,
        reason: 'conflict',
        currentDraftId: await winnerIdAfterRefusal(store, parsed.key),
      };
    }
    if (isOffline(error)) return { ok: false, reason: 'offline' };
    throw error;
  }
  return {
    ok: true,
    handle: { draftKey: parsed.key, draftId: draftIdOf(parsed.key, record.contentVersion), record },
  };
};

/**
 * Phase (0) of a send: the record states, under CAS, that a send is in flight. Every device then
 * refuses to edit or discard it — including this one — so the message SMTP is about to be handed
 * cannot change underneath the send, and a SECOND device cannot start its own send of the same
 * draft and deliver a duplicate to the recipient.
 *
 * The claim is written BEFORE SMTP for exactly that reason: tidying up afterwards can only
 * discover the race, never prevent it.
 */
export const claimSend = async (
  store: RecordStore,
  draftId: string,
  send: NonNullable<DraftRecord['send']>,
  now: number,
  /**
   * The editor's newest text, written in the SAME CAS write as the claim. Sending does not wait
   * for the autosave, so without this the record would say one thing and the bytes SMTP was
   * handed another — and the frozen bytes are supposed to BE the record.
   */
  content?: Omit<DraftRecord, 'contentVersion' | 'send' | 'sentMessageId' | 'deletedAt'>,
): Promise<SaveOutcome> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const current = await readDraft(store, parsed.key);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const currentId = draftIdOf(parsed.key, current.record.contentVersion);
  if (heldSend(current.record, now) !== undefined) return { ok: false, reason: 'sending' };
  if (current.record.contentVersion !== parsed.version) {
    return { ok: false, reason: 'conflict', currentDraftId: currentId };
  }
  const record: DraftRecord = {
    ...(content ?? current.record),
    contentVersion: parsed.version + 1,
    send,
  };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch (error) {
    if (isConflict(error)) {
      return {
        ok: false,
        reason: 'conflict',
        currentDraftId: await winnerIdAfterRefusal(store, parsed.key),
      };
    }
    if (isOffline(error)) return { ok: false, reason: 'offline' };
    throw error;
  }
  return {
    ok: true,
    handle: { draftKey: parsed.key, draftId: draftIdOf(parsed.key, record.contentVersion), record },
  };
};

/**
 * Phases (1) and (2): the send reached a new phase, written down BEFORE the next irreversible
 * step so a crash resumes from that step rather than repeating it. Only the device holding the
 * claim writes here.
 *
 * A refusal answers `null`: the record moved on without us (another device took a stale claim
 * over), and the next unlock reads what is actually there rather than this device's idea of it.
 */
export const advanceSend = async (
  store: RecordStore,
  draftId: string,
  send: NonNullable<DraftRecord['send']>,
): Promise<DraftHandle | null> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return null;
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.contentVersion !== parsed.version) return null;
  const record: DraftRecord = { ...current.record, contentVersion: parsed.version + 1, send };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch {
    return null;
  }
  return { draftKey: parsed.key, draftId: draftIdOf(parsed.key, record.contentVersion), record };
};

/**
 * Ends a send that never reached SMTP's acceptance: the claim is lifted and the draft is editable
 * again. Only the device holding the claim calls this, and only when it knows the send failed.
 */
export const releaseSend = async (store: RecordStore, draftId: string): Promise<void> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return;
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.contentVersion !== parsed.version) return;
  const { send: _released, ...rest } = current.record;
  await store
    .put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify({ ...rest, contentVersion: parsed.version + 1 }),
      precondition: { expect: 'revision', revision: current.revision },
    })
    .catch(() => undefined);
};

/**
 * "Back to editing" for a send nobody saw the end of: the claim moves aside so the draft can be
 * written again, and the frozen bytes come with it.
 *
 * Not a release. A release says the message never went out, which is exactly what this case
 * cannot say — so discarding stays refused and the bytes stay, until a sync finds the message in
 * a Sent folder or the person sends it again.
 */
export const unconfirmSend = async (
  store: RecordStore,
  draftId: string,
): Promise<DraftHandle | null> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return null;
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.contentVersion !== parsed.version) return null;
  const { send, ...rest } = current.record;
  if (send === undefined) return null;
  const record: DraftRecord = {
    ...rest,
    contentVersion: parsed.version + 1,
    unconfirmedSend: send,
  };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch {
    return null;
  }
  return { draftKey: parsed.key, draftId: draftIdOf(parsed.key, record.contentVersion), record };
};

/**
 * "Send again" for an unconfirmed send: the frozen bytes go back under a fresh claim, so the
 * machine re-runs phase (1) with the SAME message rather than composing a second one.
 */
export const reclaimSend = async (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DraftHandle | null> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return null;
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.contentVersion !== parsed.version) return null;
  const { unconfirmedSend, ...rest } = current.record;
  if (unconfirmedSend === undefined) return null;
  const record: DraftRecord = {
    ...rest,
    contentVersion: parsed.version + 1,
    send: { ...unconfirmedSend, state: 'submitting', claimedAt: now },
  };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch {
    return null;
  }
  return { draftKey: parsed.key, draftId: draftIdOf(parsed.key, record.contentVersion), record };
};

/**
 * Phase (3): the send went out, so the draft becomes a tombstone that remembers what it became.
 * Unlike `deleteDraft` this is allowed to act on a record carrying a `send` — it IS that send
 * finishing, and refusing here would leave every sent draft alive for ever.
 */
export const completeSend = async (
  store: RecordStore,
  draftId: string,
  sentMessageId: string,
  now: number,
): Promise<void> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return;
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.contentVersion !== parsed.version) return;
  const { send: _done, unconfirmedSend: _settled, ...rest } = current.record;
  await store
    .put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify({
        ...rest,
        contentVersion: parsed.version + 1,
        deletedAt: now,
        sentMessageId,
      }),
      precondition: { expect: 'revision', revision: current.revision },
    })
    .catch(() => undefined);
};

export type DeleteOutcome =
  | { readonly outcome: 'deleted'; readonly draftId: string }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'conflict'; readonly currentDraftId: string }
  | { readonly outcome: 'sending' }
  | { readonly outcome: 'offline' };

/**
 * A soft delete: the record is tombstoned rather than removed, hidden everywhere, and revivable
 * by naming its exact id for 30 days.
 *
 * That window is NOT an undo, which is the thing to keep straight here: no screen in YOZZ brings
 * a discarded draft back, so reviving one means an agent tool and an exact id. The recoverability
 * is real and it is unreachable, which is why the screens above this ask first.
 */
export const deleteDraft = async (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DeleteOutcome> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return { outcome: 'absent' };
  const current = await readDraft(store, parsed.key);
  if (current === null || current.record.deletedAt !== undefined) return { outcome: 'absent' };
  const currentId = draftIdOf(parsed.key, current.record.contentVersion);
  if (heldSend(current.record, now) !== undefined || current.record.unconfirmedSend !== undefined) {
    return { outcome: 'sending' };
  }
  if (current.record.contentVersion !== parsed.version) {
    return { outcome: 'conflict', currentDraftId: currentId };
  }
  const record: DraftRecord = {
    ...current.record,
    contentVersion: parsed.version + 1,
    deletedAt: now,
  };
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: parsed.key,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision: current.revision },
    });
  } catch (error) {
    if (isConflict(error)) {
      const winner = await winnerIdAfterRefusal(store, parsed.key);
      return winner === null
        ? { outcome: 'absent' }
        : { outcome: 'conflict', currentDraftId: winner };
    }
    if (isOffline(error)) return { outcome: 'offline' };
    throw error;
  }
  return { outcome: 'deleted', draftId: draftIdOf(parsed.key, record.contentVersion) };
};

/** Undoes a soft delete by naming the tombstone's exact id. */
export const reviveDraft = async (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<SaveOutcome> => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const current = await readDraft(store, parsed.key);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const { deletedAt: _gone, ...rest } = current.record;
  return replaceDraft(store, draftIdOf(parsed.key, current.record.contentVersion), rest, now);
};

/**
 * Erases tombstones past their revival window. Run from the unlock that lists drafts, because a
 * retention promise nothing enforces is just unbounded growth in somebody's vault — and these are
 * records the server can never garbage-collect for us, since it cannot read them.
 *
 * Best effort per record: a refusal means that tombstone moved on (revived, or purged by another
 * device), and the next unlock will look again.
 */
export const purgeExpiredDrafts = async (store: RecordStore, now: number): Promise<number> => {
  const rows = await store.list(DRAFT_RECORD_TYPE);
  let purged = 0;
  for (const row of rows) {
    const record = parseDraftRecord(row.plaintext);
    if (record?.deletedAt === undefined || now - record.deletedAt < DRAFT_TOMBSTONE_MS) continue;
    try {
      await store.remove(DRAFT_RECORD_TYPE, row.naturalKey, row.revision);
      await store.remove(DRAFT_MIRROR_RECORD_TYPE, row.naturalKey).catch(() => undefined);
      purged += 1;
    } catch {
      // Moved on since the list: leave it for the next unlock.
    }
  }
  return purged;
};

/** Every live draft: tombstones and their 30-day wait are nobody's business but the purge's. */
export const listDrafts = async (store: RecordStore): Promise<readonly DraftHandle[]> => {
  const rows = await store.list(DRAFT_RECORD_TYPE);
  return rows.flatMap(row => {
    const record = parseDraftRecord(row.plaintext);
    if (record === null || record.deletedAt !== undefined) return [];
    return [
      {
        draftKey: row.naturalKey,
        draftId: draftIdOf(row.naturalKey, record.contentVersion),
        record,
      },
    ];
  });
};

export const readMirror = async (
  store: RecordStore,
  draftKey: string,
): Promise<{ mirror: DraftMirrorRecord; revision: number } | null> => {
  const opened = await store.get(DRAFT_MIRROR_RECORD_TYPE, draftKey);
  if (opened === null) return null;
  const mirror = parseDraftMirrorRecord(opened.plaintext);
  return mirror === null ? null : { mirror, revision: opened.revision };
};

/**
 * Mirror bookkeeping is its OWN record, so writing it never bumps the content's version and never
 * races an edit: a mirror task finishing late must not make the person's next save a conflict.
 *
 * Written under compare-and-swap like everything else in this file. Two devices that mirrored the
 * same draft would otherwise overwrite each other's bookkeeping out of order, and the locator the
 * loser wrote — the one naming a real message on the server — would be lost with nothing left to
 * clean it up. `false` says another device got there first; the caller re-reads rather than
 * insisting.
 */
export const writeMirror = async (
  store: RecordStore,
  draftKey: string,
  mirror: DraftMirrorRecord,
  precondition: { expect: 'absent' } | { expect: 'revision'; revision: number },
): Promise<boolean> => {
  try {
    await store.put({
      type: DRAFT_MIRROR_RECORD_TYPE,
      naturalKey: draftKey,
      plaintext: JSON.stringify(mirror),
      precondition,
    });
  } catch {
    return false;
  }
  return true;
};
