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
 * Drafts in the vault under compare-and-swap: the loser is refused and told the current version,
 * and the person decides. Online only, like every vault write today.
 */

export type DraftHandle = {
  readonly draftKey: string;
  readonly draftId: string;
  readonly record: DraftRecord;
};

export type SaveOutcome =
  | { readonly ok: true; readonly handle: DraftHandle }
  /** Someone else's version is current; `currentDraftId` is what a retry must name. */
  | { readonly ok: false; readonly reason: 'conflict'; readonly currentDraftId: string | null }
  /** A send is in flight for this draft on some device. */
  | { readonly ok: false; readonly reason: 'sending' }
  | { readonly ok: false; readonly reason: 'offline' };

const isConflict = (error: unknown) => error instanceof VaultApiError && error.code === 'CONFLICT';

/** The id that won, read after the refusal: the pre-race id is the caller's own stale one. */
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
      // No row yet; a key collision would silently take somebody else's draft.
      precondition: { expect: 'absent' },
    });
  } catch (error) {
    if (isConflict(error)) return { ok: false, reason: 'conflict', currentDraftId: null };
    if (isOffline(error)) return { ok: false, reason: 'offline' };
    throw error;
  }
  return { ok: true, handle: { draftKey, draftId: draftIdOf(draftKey, 1), record } };
};

/** A full snapshot, never a patch. `draftId` names the version this replaces. */
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
  // A send in flight freezes the content on every device.
  if (heldSend(current.record, now) !== undefined) return { ok: false, reason: 'sending' };
  if (current.record.contentVersion !== parsed.version) {
    return { ok: false, reason: 'conflict', currentDraftId: currentId };
  }
  // Which conversation the draft belongs to is not text in the editor, so the composer's saves do not carry it.
  const threadId = content.threadId ?? current.record.threadId;
  const record: DraftRecord = {
    ...content,
    ...(threadId === undefined ? {} : { threadId }),
    contentVersion: parsed.version + 1,
    updatedAt: now,
    // Editing does not settle an unconfirmed send: the bytes and the refusal to discard survive.
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
 * Phase (0): the record states under CAS that a send is in flight, written before SMTP so a
 * second device cannot deliver a duplicate.
 */
export const claimSend = async (
  store: RecordStore,
  draftId: string,
  send: NonNullable<DraftRecord['send']>,
  now: number,
  // The editor's newest text, in the same CAS write as the claim: sending does not wait for the autosave.
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
 * Phases (1) and (2), written before the next irreversible step so a crash resumes rather than
 * repeats. `null` means the record moved on without us.
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

/** Ends a send that never reached SMTP's acceptance: the claim is lifted. */
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
 * "Back to editing" for an unconfirmed send. Not a release: that would say the message never went
 * out, so discarding stays refused until a sync finds it in Sent or the person sends again.
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

/** "Send again": the frozen bytes go back under a fresh claim, so phase (1) re-runs the same message. */
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

/** Phase (3): the draft becomes a tombstone. Unlike `deleteDraft`, allowed on a record carrying a `send`. */
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

/** Soft delete, revivable by exact id for 30 days. No screen revives one, so the screens above ask first. */
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

/** Erases tombstones past their window, from the unlock that lists drafts; the server cannot read them to collect them. Best effort per record. */
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
      // Moved on since the list.
    }
  }
  return purged;
};

/** Every live draft. */
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
 * Its own record, so a late mirror task never makes the next save a conflict. Under CAS too:
 * `false` says another device got there first, and the caller re-reads.
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
