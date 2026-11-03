import { VaultApiError } from '../vault/api.ts';
import type { RecordStore } from '../vault/record-store.ts';
import {
  DRAFT_MIRROR_RECORD_TYPE,
  DRAFT_RECORD_TYPE,
  DRAFT_TOMBSTONE_MS,
  type DraftMirrorRecord,
  type DraftRecord,
  draftIdOf,
  heldSend,
  isFrozenBySend,
  newDraftKey,
  openSendStateOf,
  parseDraftId,
  parseDraftMirrorRecord,
  parseDraftRecord,
  parseSendLease,
  SEND_LEASE_CEILING_MS,
  SEND_LEASE_CLEANUP_MS,
  SEND_LEASE_MS,
  SEND_LEASE_RECORD_TYPE,
  SEND_LEASE_RENEW_MS,
  unconfirmedSendOf,
} from './draft-record.ts';

/**
 * Drafts live in the vault under compare-and-swap: the loser is refused and told the current
 * version, and the person decides. Online only, like every vault write today.
 */

export type DraftHandle = {
  readonly draftKey: string;
  readonly draftId: string;
  readonly record: DraftRecord;
  /** The send's lease as last read, for what renders. A write that decides something reads it again. */
  readonly renewedAt?: number;
};

export type SaveOutcome =
  | { readonly ok: true; readonly handle: DraftHandle }
  /** Someone else's version is current; `currentDraftId` is what a retry must name. */
  | { readonly ok: false; readonly reason: 'conflict'; readonly currentDraftId: string | null }
  /** A send is in flight for this draft on some device. */
  | { readonly ok: false; readonly reason: 'sending' }
  | { readonly ok: false; readonly reason: 'offline' };

const isConflict = (error: unknown) => error instanceof VaultApiError && error.code === 'CONFLICT';

const handleOf = (draftKey: string, record: DraftRecord, renewedAt?: number): DraftHandle => ({
  draftKey,
  draftId: draftIdOf(draftKey, record.contentVersion),
  record,
  ...(renewedAt === undefined ? {} : { renewedAt }),
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

/** When the record's send last renewed its lease, if it has. */
export const readSendLease = async (
  store: RecordStore,
  { send }: DraftRecord,
): Promise<number | undefined> => {
  if (send === undefined) return undefined;
  const opened = await store.get(SEND_LEASE_RECORD_TYPE, send.opId);
  return opened === null ? undefined : parseSendLease(opened.plaintext)?.renewedAt;
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
  // A send in flight, or one waiting for the person to settle it, freezes the content on every device.
  if (isFrozenBySend(current.record)) return { ok: false, reason: 'sending' };
  if (!current.isCurrent) {
    return { ok: false, reason: 'conflict', currentDraftId: current.currentId };
  }
  // Which conversation the draft belongs to is not text in the editor, so the composer's saves do not carry it.
  const threadId = content.threadId ?? current.record.threadId;
  // Nor do an agent's: a whole snapshot of the text, which says nothing about the files.
  const attachments = content.attachments ?? current.record.attachments;
  const record: DraftRecord = {
    ...content,
    ...(threadId === undefined ? {} : { threadId }),
    ...(attachments === undefined ? {} : { attachments }),
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
 * Phase (0): the record states under CAS that a send is in flight, written before SMTP so a second
 * device cannot deliver a duplicate.
 */
export const claimSend = async (
  store: RecordStore,
  draftId: string,
  send: NonNullable<DraftRecord['send']>,
  // The editor's newest text, in the same CAS write as the claim: sending does not wait for the autosave.
  content?: Omit<DraftRecord, 'contentVersion' | 'send' | 'sentMessageId' | 'deletedAt'>,
): Promise<SaveOutcome> => {
  const current = await readVersion(store, draftId);
  if (current === null) return { ok: false, reason: 'conflict', currentDraftId: null };
  if (isFrozenBySend(current.record)) return { ok: false, reason: 'sending' };
  if (!current.isCurrent) {
    return { ok: false, reason: 'conflict', currentDraftId: current.currentId };
  }
  // Which conversation it belongs to is not text in the editor, as in `replaceDraft`.
  const threadId = content?.threadId ?? current.record.threadId;
  const record: DraftRecord = {
    ...(content ?? current.record),
    ...(threadId === undefined ? {} : { threadId }),
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
  next: (
    record: DraftRecord,
  ) =>
    | Omit<DraftRecord, 'contentVersion'>
    | null
    | Promise<Omit<DraftRecord, 'contentVersion'> | null>,
): Promise<DraftHandle | null> => {
  const current = await readVersion(store, draftId);
  if (current === null || !current.isCurrent) return null;
  const fields = await next(current.record);
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
 * "Back to editing" for an unconfirmed send. Not a release, which would say the message never went
 * out: discarding stays refused until a sync finds it in Sent or the person sends again. Asks the
 * lease first: what was on screen may be minutes old, and it never applies to a send SMTP accepted.
 */
export const unconfirmSend = (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DraftHandle | null> =>
  bumpVersion(store, draftId, async record => {
    const { send, ...rest } = record;
    const unconfirmed = unconfirmedSendOf(record, await readSendLease(store, record), now);
    return send === undefined || unconfirmed === undefined
      ? null
      : { ...rest, unconfirmedSend: send };
  });

/**
 * Takes over a send nobody is running, under a fresh claim. The compare-and-swap lets one click or
 * device through. Unconfirmed, the frozen bytes go out again: "Send again", the person's call. SMTP
 * having accepted it, it stays at its phase, so nothing but the copy can follow. `null` is a send
 * still running, one settled since, or nothing to take over.
 */
export const reclaimSend = (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DraftHandle | null> =>
  bumpVersion(store, draftId, async record => {
    const renewedAt = await readSendLease(store, record);
    if (heldSend(record, renewedAt, now) !== undefined) return null;
    const pending = unconfirmedSendOf(record, renewedAt, now) ?? record.send;
    if (pending === undefined) return null;
    const { unconfirmedSend: _reclaimed, ...rest } = record;
    return {
      ...rest,
      send: {
        ...pending,
        opId: crypto.randomUUID(),
        state: pending.state === 'unconfirmed' ? 'submitting' : pending.state,
        claimedAt: now,
      },
    };
  });

/** The draft as a tombstone that remembers what it became. It stops naming its files, which frees them. */
const tombstoneOfSent = (
  { send: _done, unconfirmedSend: _settled, attachments: _freed, ...rest }: DraftRecord,
  sentMessageId: string,
  now: number,
  options: { readonly isSentWithoutCopy?: true } = {},
) => ({ ...rest, deletedAt: now, sentMessageId, ...options });

/**
 * Phase (3): the draft becomes a tombstone. Unlike `deleteDraft`, allowed on a record carrying a
 * `send`, now that the Sent copy is safe.
 */
export const completeSend = async (
  store: RecordStore,
  draftId: string,
  sentMessageId: string,
  now: number,
  options?: { readonly isSentWithoutCopy?: true },
): Promise<void> => {
  await bumpVersion(store, draftId, record => tombstoneOfSent(record, sentMessageId, now, options));
};

/** The way out when a copy can never land: the message went out, so the person may let the copy go. */
export const finishWithoutCopy = (
  store: RecordStore,
  draftId: string,
  now: number,
): Promise<DraftHandle | null> =>
  bumpVersion(store, draftId, async record => {
    const state = openSendStateOf(record, await readSendLease(store, record), now);
    return state === 'accepted' && record.send !== undefined
      ? tombstoneOfSent(record, record.send.messageId, now, { isSentWithoutCopy: true })
      : null;
  });

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
  const { send, unconfirmedSend } = current.record;
  // A claim nobody ran past `submitting` may never have reached SMTP, and is the person's to drop.
  const isDiscardable =
    send === undefined
      ? unconfirmedSend === undefined
      : send.state === 'submitting' &&
        heldSend(current.record, await readSendLease(store, current.record), now) === undefined;
  if (!isDiscardable) return { outcome: 'sending' };
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

/** Rows a dead tab left behind: past its window a lease says nothing the claim doesn't. Best effort per row. */
export const purgeSendLeases = async (store: RecordStore, now: number): Promise<void> => {
  const rows = await store.list(SEND_LEASE_RECORD_TYPE);
  for (const { naturalKey, plaintext } of rows) {
    if (now - (parseSendLease(plaintext)?.renewedAt ?? 0) < SEND_LEASE_MS) continue;
    await store.remove(SEND_LEASE_RECORD_TYPE, naturalKey).catch(() => undefined);
  }
};

/**
 * Renews the lease of the claim `opId` until the returned stop is called. One write at a time, as
 * an older one must not land over a newer. A failed write is a missed beat and never touches the
 * send it serves. Most sends end before the first beat, and write nothing.
 */
export const keepSendLease = (store: RecordStore, opId: string, now: () => number) => {
  const startedAt = now();
  let renewing: Promise<void> | null = null;
  let hasRenewed = false;
  const timer = setInterval(() => {
    if (now() - startedAt >= SEND_LEASE_CEILING_MS) {
      clearInterval(timer);
      return;
    }
    if (renewing !== null) return;
    hasRenewed = true;
    renewing = (async () => {
      try {
        await store.put({
          type: SEND_LEASE_RECORD_TYPE,
          naturalKey: opId,
          plaintext: JSON.stringify({ renewedAt: now() }),
        });
      } catch {
        // The next beat tries again.
      } finally {
        renewing = null;
      }
    })();
  }, SEND_LEASE_RENEW_MS);
  return async (): Promise<void> => {
    clearInterval(timer);
    const removing = (async () => {
      await renewing;
      if (hasRenewed) await store.remove(SEND_LEASE_RECORD_TYPE, opId).catch(() => undefined);
    })();
    // The vault API has no timeout, and a write that hangs must not hold a send that has ended.
    const limit = Promise.withResolvers<void>();
    const limiting = setTimeout(limit.resolve, SEND_LEASE_CLEANUP_MS);
    await Promise.race([removing, limit.promise]);
    clearTimeout(limiting);
  };
};

/** Every live draft, with the lease of each one a send holds. */
export const listDrafts = async (store: RecordStore): Promise<readonly DraftHandle[]> => {
  const rows = await store.list(DRAFT_RECORD_TYPE);
  const drafts = rows.flatMap(({ naturalKey, plaintext }) => {
    const record = parseDraftRecord(plaintext);
    return record === null || record.deletedAt !== undefined ? [] : [{ naturalKey, record }];
  });
  const leases = drafts.some(({ record }) => record.send !== undefined)
    ? await store.list(SEND_LEASE_RECORD_TYPE)
    : [];
  const renewedAt = new Map(
    leases.map(({ naturalKey, plaintext }) => [naturalKey, parseSendLease(plaintext)?.renewedAt]),
  );
  return drafts.map(({ naturalKey, record }) =>
    handleOf(naturalKey, record, renewedAt.get(record.send?.opId ?? '')),
  );
};

/** One draft as it stands now, or `null` once it is gone. */
export const readDraftHandle = async (
  store: RecordStore,
  draftKey: string,
): Promise<DraftHandle | null> => {
  const current = await readDraft(store, draftKey);
  if (current === null || current.record.deletedAt !== undefined) return null;
  return handleOf(draftKey, current.record, await readSendLease(store, current.record));
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
