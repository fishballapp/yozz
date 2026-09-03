import { VaultApiError } from '../vault/api';
import type { RecordStore } from '../vault/record-store';
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
} from './draft-record';

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

const handleOf = (draftKey: string, record: DraftRecord): DraftHandle => ({
  draftKey,
  draftId: draftIdOf(draftKey, record.contentVersion),
  record,
});

const readDraft = async (
  store: RecordStore,
  draftKey: string,
): Promise<{ record: DraftRecord; revision: number } | null> => {
  const opened = await store.get(DRAFT_RECORD_TYPE, draftKey);
  if (opened === null) return null;
  const record = parseDraftRecord(opened.plaintext);
  return record === null ? null : { record, revision: opened.revision };
};

/** The record a versioned id names, if the id parses and the record exists; `isCurrent` says the id names its newest version. */
const readVersion = async (store: RecordStore, draftId: string) => {
  const parsed = parseDraftId(draftId);
  if (parsed === null) return null;
  const current = await readDraft(store, parsed.key);
  if (current === null) return null;
  return {
    key: parsed.key,
    version: parsed.version,
    ...current,
    isCurrent: current.record.contentVersion === parsed.version,
    currentId: draftIdOf(parsed.key, current.record.contentVersion),
  };
};

/** The id that won, read after the refusal: the pre-race id is the caller's own stale one. */
const winnerIdAfterRefusal = async (
  store: RecordStore,
  draftKey: string,
): Promise<string | null> => {
  const now = await readDraft(store, draftKey);
  return now === null ? null : draftIdOf(draftKey, now.record.contentVersion);
};

/** The CAS write every version bump shares. Any failure other than a refused precondition is the network. */
const putVersion = async (
  store: RecordStore,
  draftKey: string,
  record: DraftRecord,
  revision: number,
): Promise<'ok' | 'conflict' | 'offline'> => {
  try {
    await store.put({
      type: DRAFT_RECORD_TYPE,
      naturalKey: draftKey,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'revision', revision },
    });
  } catch (error) {
    return isConflict(error) ? 'conflict' : 'offline';
  }
  return 'ok';
};

/** A save's answer to a refused CAS: the winner's id on a conflict, `offline` otherwise. */
const refusedSave = async (
  store: RecordStore,
  draftKey: string,
  refusal: 'conflict' | 'offline',
): Promise<SaveOutcome> =>
  refusal === 'conflict'
    ? { ok: false, reason: 'conflict', currentDraftId: await winnerIdAfterRefusal(store, draftKey) }
    : { ok: false, reason: 'offline' };

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
    return isConflict(error)
      ? { ok: false, reason: 'conflict', currentDraftId: null }
      : { ok: false, reason: 'offline' };
  }
  return { ok: true, handle: handleOf(draftKey, record) };
};

/** A full snapshot, never a patch. `draftId` names the version this replaces. */
export const replaceDraft = async (
  store: RecordStore,
  draftId: string,
  content: Omit<DraftRecord, 'contentVersion' | 'send' | 'sentMessageId' | 'deletedAt'>,
  now: number,
): Promise<SaveOutcome> => {
  const current = await readVersion(store, draftId);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  // A send in flight freezes the content on every device.
  if (heldSend(current.record, now) !== undefined) return { ok: false, reason: 'sending' };
  if (!current.isCurrent) {
    return { ok: false, reason: 'conflict', currentDraftId: current.currentId };
  }
  // Which conversation the draft belongs to is not text in the editor, so the composer's saves do not carry it.
  const threadId = content.threadId ?? current.record.threadId;
  const record: DraftRecord = {
    ...content,
    ...(threadId === undefined ? {} : { threadId }),
    contentVersion: current.version + 1,
    updatedAt: now,
    // Editing does not settle an unconfirmed send: the bytes and the refusal to discard survive.
    ...(current.record.unconfirmedSend === undefined
      ? {}
      : { unconfirmedSend: current.record.unconfirmedSend }),
  };
  const written = await putVersion(store, current.key, record, current.revision);
  if (written !== 'ok') return refusedSave(store, current.key, written);
  return { ok: true, handle: handleOf(current.key, record) };
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
  const current = await readVersion(store, draftId);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  if (heldSend(current.record, now) !== undefined) return { ok: false, reason: 'sending' };
  if (!current.isCurrent) {
    return { ok: false, reason: 'conflict', currentDraftId: current.currentId };
  }
  const record: DraftRecord = {
    ...(content ?? current.record),
    contentVersion: current.version + 1,
    send,
  };
  const written = await putVersion(store, current.key, record, current.revision);
  if (written !== 'ok') return refusedSave(store, current.key, written);
  return { ok: true, handle: handleOf(current.key, record) };
};

/**
 * The version bump the send machine's phases share: the record moves on only if `draftId` still
 * names its newest version, and `null` means it moved on without us.
 */
const bumpVersion = async (
  store: RecordStore,
  draftId: string,
  next: (record: DraftRecord) => Omit<DraftRecord, 'contentVersion'> | null,
): Promise<DraftHandle | null> => {
  const current = await readVersion(store, draftId);
  if (current === null || !current.isCurrent) return null;
  const fields = next(current.record);
  if (fields === null) return null;
  const record: DraftRecord = { ...fields, contentVersion: current.version + 1 };
  const written = await putVersion(store, current.key, record, current.revision);
  return written === 'ok' ? handleOf(current.key, record) : null;
};

/**
 * Phases (1) and (2), written before the next irreversible step so a crash resumes rather than
 * repeats. `null` means the record moved on without us.
 */
export const advanceSend = (
  store: RecordStore,
  draftId: string,
  send: NonNullable<DraftRecord['send']>,
): Promise<DraftHandle | null> => bumpVersion(store, draftId, record => ({ ...record, send }));

/** Ends a send that never reached SMTP's acceptance: the claim is lifted. */
export const releaseSend = async (store: RecordStore, draftId: string): Promise<void> => {
  await bumpVersion(store, draftId, ({ send: _released, ...rest }) => rest);
};

/**
 * "Back to editing" for an unconfirmed send. Not a release: that would say the message never went
 * out, so discarding stays refused until a sync finds it in Sent or the person sends again.
 */
export const unconfirmSend = (store: RecordStore, draftId: string): Promise<DraftHandle | null> =>
  bumpVersion(store, draftId, ({ send, ...rest }) =>
    send === undefined ? null : { ...rest, unconfirmedSend: send },
  );

/** "Send again": the frozen bytes go back under a fresh claim, so phase (1) re-runs the same message. */
export const reclaimSend = (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DraftHandle | null> =>
  bumpVersion(store, draftId, ({ unconfirmedSend, ...rest }) =>
    unconfirmedSend === undefined
      ? null
      : { ...rest, send: { ...unconfirmedSend, state: 'submitting', claimedAt: now } },
  );

/** Phase (3): the draft becomes a tombstone. Unlike `deleteDraft`, allowed on a record carrying a `send`. */
export const completeSend = async (
  store: RecordStore,
  draftId: string,
  sentMessageId: string,
  now: number,
): Promise<void> => {
  await bumpVersion(store, draftId, ({ send: _done, unconfirmedSend: _settled, ...rest }) => ({
    ...rest,
    deletedAt: now,
    sentMessageId,
  }));
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
  const current = await readVersion(store, draftId);
  if (current === null || current.record.deletedAt !== undefined) return { outcome: 'absent' };
  if (heldSend(current.record, now) !== undefined || current.record.unconfirmedSend !== undefined) {
    return { outcome: 'sending' };
  }
  if (!current.isCurrent) return { outcome: 'conflict', currentDraftId: current.currentId };
  const record: DraftRecord = {
    ...current.record,
    contentVersion: current.version + 1,
    deletedAt: now,
  };
  const written = await putVersion(store, current.key, record, current.revision);
  if (written === 'offline') return { outcome: 'offline' };
  if (written === 'conflict') {
    const winner = await winnerIdAfterRefusal(store, current.key);
    return winner === null
      ? { outcome: 'absent' }
      : { outcome: 'conflict', currentDraftId: winner };
  }
  return { outcome: 'deleted', draftId: draftIdOf(current.key, record.contentVersion) };
};

/** Undoes a soft delete by naming the tombstone's exact id. */
export const reviveDraft = async (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<SaveOutcome> => {
  const current = await readVersion(store, draftId);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  const { deletedAt: _gone, ...rest } = current.record;
  return replaceDraft(store, current.currentId, rest, now);
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
    return [handleOf(row.naturalKey, record)];
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
