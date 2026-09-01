import type { DraftRecord } from '../lib/drafts';
import type { RecordStore } from '../vault/record-store';
import type { MailConnectionFailure, Result } from './connection';
import { type DraftHandle, readMirror, writeMirror } from './draft-records';
import type { LiveClient, LiveTask } from './live';
import { resolveFolders } from './mailboxes';

/**
 * The IMAP copy of a vault draft, in the account's own Drafts folder.
 *
 * The vault record is the draft; this copy is a courtesy to every OTHER client you own — a draft
 * you started here shows up in Thunderbird or the provider's web mail, and one you abandon does
 * not linger there. It is never read back as authority.
 *
 * Bookkeeping lives in its own `draft-mirror` record, so writing it never bumps the content's
 * version and a mirror finishing late cannot turn the person's next save into a conflict.
 */

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/**
 * The Message-ID every copy of one draft carries, so a later mirror finds ALL of them and not just
 * the newest. Derived from the draft key rather than minted per copy, which is the whole point.
 *
 * It is a Message-ID and NOT a custom `X-Yozz-Draft` header because a server only has to index the
 * headers IMAP names. Forward Email indexes none of ours: `SEARCH HEADER X-Yozz-Draft <key>`
 * answers an empty list for a message that demonstrably carries it, while the same search on
 * Message-ID or Subject finds it. That empty list read as "no copies to erase, we are done", so
 * every discard reported success and left the copy on the server for ever.
 */
export const draftMirrorMessageId = (draftKey: string, account: string): string =>
  `<yozz-draft-${draftKey}@${account.slice(account.indexOf('@') + 1)}>`;

/**
 * Which account holds the copy: the sending address when it has a mailbox of its own, else the
 * account whose thread the draft replies to. A new message from a send-only address belongs to no
 * account, and gets no mirror — `null` says so.
 */
export const mirrorAccountOf = (
  record: DraftRecord,
  isInbound: (address: string) => boolean,
): string | null => (isInbound(record.from) ? record.from : (record.ownerAccount ?? null));

/**
 * Erases every copy of this draft in the SELECTED mailbox except `keep`.
 *
 * A search rather than the locator we wrote down, because the locator names one copy and a failed
 * erase leaves another: asking the server which messages carry this draft's Message-ID finds them
 * all, so each mirror cleans up after the last one. Answers `false` when the server refused
 * something, and the caller then keeps the bookkeeping it already had rather than claiming the
 * copy is gone.
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
 * Replaces the account's copy with one holding this version, then erases the copies it replaces.
 *
 * APPEND-then-erase rather than erase-then-APPEND: a crash between the two leaves a duplicate that
 * the next run tidies, where the other order would leave the person with no draft at all.
 * `UID EXPUNGE` needs UIDPLUS — without it there is no way to erase only our own copy, so the
 * account simply gets no mirror rather than a Drafts folder that fills up with every keystroke.
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
      // Best effort: a copy left behind is a stray draft in the person's own Drafts folder, which
      // the next mirror finds by the same search. It must not stop the new copy being recorded.
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

/**
 * Erases the account's copies: what a discard and the end of a send both owe the other clients.
 *
 * The mirror record keeps its locator until the server has confirmed the erase, so a failure here
 * is retried by the next run rather than forgotten.
 */
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
      // A renumbered mailbox hands the same uid to different mail, so the search — not the stored
      // uid — is what says which messages are ours. `-1` keeps nothing: they all go.
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
