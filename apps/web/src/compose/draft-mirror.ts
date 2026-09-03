import { resolveFolders } from '../addresses/mailboxes';
import type { MailConnectionFailure, Result } from '../relay/connection';
import type { LiveClient, LiveTask } from '../relay/live';
import type { RecordStore } from '../vault/record-store';
import type { DraftRecord } from './draft-record';
import { type DraftHandle, readMirror, writeMirror } from './draft-vault';

/**
 * The IMAP copy of a vault draft, a courtesy to the user's other clients and never read back as
 * authority. Bookkeeping is its own record so a late mirror cannot conflict with a save.
 */

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/**
 * Derived from the draft key so a later mirror finds every copy. A Message-ID rather than an
 * `X-Yozz-Draft` header because Forward Email indexes only the headers IMAP names: `SEARCH
 * HEADER X-Yozz-Draft` answered empty for a message that carried it.
 */
export const draftMirrorMessageId = (draftKey: string, account: string): string =>
  `<yozz-draft-${draftKey}@${account.slice(account.indexOf('@') + 1)}>`;

/** The sending address when it has a mailbox, else the account whose thread the draft replies to; `null` for a new message from a send-only address. */
export const mirrorAccountOf = (
  record: DraftRecord,
  isInbound: (address: string) => boolean,
): string | null => (isInbound(record.from) ? record.from : (record.ownerAccount ?? null));

/**
 * A search rather than the stored locator, so each mirror cleans up after the last one. `false`
 * means the server refused something and the caller keeps its bookkeeping.
 */
const eraseOthers = async (
  client: LiveClient,
  messageId: string,
  keep: number,
): Promise<boolean> => {
  const found = await client.uidSearchHeader('Message-ID', messageId);
  if (!found.ok) return false;
  const stale = found.value.filter(uid => uid !== keep);
  if (stale.length === 0) return true;
  const uids = stale.join(',');
  const flagged = await client.storeFlags(uids, 'add', ['\\Deleted']);
  if (!flagged.ok) return false;
  return (await client.uidExpunge(uids)).ok;
};

/**
 * APPEND-then-erase: a crash between the two leaves a duplicate, where the other order leaves no
 * draft. `UID EXPUNGE` needs UIDPLUS; without it the account gets no mirror.
 */
export const mirrorDraft = async (
  run: Run,
  store: RecordStore,
  handle: DraftHandle,
  bytes: Uint8Array,
  account: string,
): Promise<void> => {
  const existing = await readMirror(store, handle.draftKey);
  if (existing !== null && existing.mirror.mirroredVersion >= handle.record.contentVersion) return;

  const written = await run({
    priority: 'background',
    // An APPEND re-run would duplicate the copy; the next save mirrors the newer version anyway.
    retry: false,
    run: async client => {
      if (!client.hasCapability('UIDPLUS')) return { ok: true, value: null };
      const folders = await resolveFolders(client);
      if (!folders.ok) return folders;
      const drafts = folders.value.drafts;
      if (drafts === undefined) return { ok: true, value: null };
      const selected = await client.select(drafts);
      if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
      const appended = await client.append(drafts, bytes, ['\\Seen', '\\Draft']);
      if (!appended.ok) return { ok: false, error: { kind: 'imap', reason: appended.reason } };
      const landed = appended.value;
      if (landed === null) return { ok: true, value: null };
      // Best effort: a copy left behind is found by the next mirror's search.
      await eraseOthers(client, draftMirrorMessageId(handle.draftKey, account), landed.uid);
      return { ok: true, value: { account, folder: drafts, ...landed } };
    },
  });
  if (!written.ok) return;
  await writeMirror(
    store,
    handle.draftKey,
    {
      mirroredVersion: handle.record.contentVersion,
      ...(written.value === null ? {} : { locator: written.value }),
    },
    existing === null ? { expect: 'absent' } : { expect: 'revision', revision: existing.revision },
  );
};

/** The mirror record keeps its locator until the server confirms the erase. */
export const expungeMirror = async (
  run: Run,
  store: RecordStore,
  draftKey: string,
): Promise<void> => {
  const existing = await readMirror(store, draftKey);
  const locator = existing?.mirror.locator;
  if (existing === null || locator === undefined) return;
  const erased = await run({
    priority: 'background',
    retry: true,
    run: async client => {
      if (!client.hasCapability('UIDPLUS')) return { ok: true, value: false };
      const selected = await client.select(locator.folder);
      if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
      // A renumbered mailbox hands the same uid to different mail, so the search says which are ours. `-1` keeps nothing.
      if (selected.value.uidValidity !== locator.uidValidity) return { ok: true, value: false };
      return {
        ok: true,
        value: await eraseOthers(client, draftMirrorMessageId(draftKey, locator.account), -1),
      };
    },
  });
  if (!erased.ok || !erased.value) return;
  await writeMirror(
    store,
    draftKey,
    { mirroredVersion: existing.mirror.mirroredVersion },
    { expect: 'revision', revision: existing.revision },
  );
};
