import type { ImapClient, ImapMailbox } from '@yozz.app/imap';
import type { MailConnectionFailure, Result } from '../connection.ts';
import type { Folder } from '../threads/thread.ts';

/** RFC 6154 names the folder; servers without SPECIAL-USE mostly agree on how they spell it. */
const SENT_FOLDER_NAMES = new Set(['sent', 'sent items', 'sent messages', 'sent mail']);
const ARCHIVE_FOLDER_NAMES = new Set(['archive', 'archives']);
/** Gmail's is under its own namespace; `Draft` singular is Exchange's. */
const DRAFTS_FOLDER_NAMES = new Set(['drafts', '[gmail]/drafts', 'draft']);
const TRASH_FOLDER_NAMES = new Set([
  'trash',
  'deleted',
  'deleted items',
  'deleted messages',
  'bin',
]);
/** Gmail's is under its own namespace; `Junk Email` is Outlook's, and Yahoo files spam in `Bulk`. */
const JUNK_FOLDER_NAMES = new Set([
  'junk',
  'spam',
  'junk email',
  'junk e-mail',
  'bulk mail',
  'bulk',
  '[gmail]/spam',
]);

/**
 * The folders a move can create. `INBOX` is reserved; Sent only ever receives copies; Junk is never
 * made, since RFC 6154 warns that a new `\Junk` mailbox may set the server filing spam into it.
 */
type MovableFolder = Extract<Folder, 'archive' | 'trash'>;

/** What one is called when the server has none and a move has to make it. */
const CREATED_NAME: Record<MovableFolder, string> = { archive: 'Archive', trash: 'Trash' };

/**
 * The first folder `LIST` marks with `attribute`, else the first with a usual name. First, because a
 * server may mark two: older Forward Email mailboxes list both `Spam` and `Junk` as `\Junk`.
 */
const specialUseOf = (
  listed: readonly ImapMailbox[],
  attribute: string,
  names: ReadonlySet<string>,
) =>
  listed.find(entry => entry.attributes.some(a => a.toLowerCase() === attribute)) ??
  listed.find(entry => names.has(entry.name.toLowerCase()));

/**
 * `INBOX` is reserved by the protocol; Sent, Archive, Trash, Junk and Drafts are whichever folder
 * `LIST` marks with the matching special-use attribute, else the usual names, else absent. A sync
 * never creates them; only a move does, and only Archive or Trash.
 */
export const resolveFolders = async (
  client: ImapClient,
): Promise<Result<Partial<Record<Folder, string>>, MailConnectionFailure>> => {
  const listed = await client.list('', '*');
  if (!listed.ok) return { ok: false, error: { kind: 'imap', reason: listed.reason } };
  const sent = specialUseOf(listed.value, '\\sent', SENT_FOLDER_NAMES);
  const archive = specialUseOf(listed.value, '\\archive', ARCHIVE_FOLDER_NAMES);
  const trash = specialUseOf(listed.value, '\\trash', TRASH_FOLDER_NAMES);
  const junk = specialUseOf(listed.value, '\\junk', JUNK_FOLDER_NAMES);
  const drafts = specialUseOf(listed.value, '\\drafts', DRAFTS_FOLDER_NAMES);
  return {
    ok: true,
    value: {
      inbox: 'INBOX',
      ...(sent === undefined ? {} : { sent: sent.name }),
      ...(archive === undefined ? {} : { archive: archive.name }),
      ...(trash === undefined ? {} : { trash: trash.name }),
      ...(junk === undefined ? {} : { junk: junk.name }),
      ...(drafts === undefined ? {} : { drafts: drafts.name }),
    },
  };
};

/**
 * Resolve a destination folder, creating it when LIST has none. Used by moves only. A refused
 * CREATE asks LIST once more, since a client that keeps LIST's answer (the web app's live
 * connection) may not know of a folder made elsewhere since.
 */
export const ensureFolderName = async (
  client: ImapClient,
  folder: MovableFolder,
): Promise<Result<string, MailConnectionFailure>> => {
  const folders = await resolveFolders(client);
  if (!folders.ok) return folders;
  const resolved = folders.value[folder];
  if (resolved !== undefined) return { ok: true, value: resolved };
  const name = CREATED_NAME[folder];
  const created = await client.create(name);
  if (created.ok) return { ok: true, value: name };
  const again = await resolveFolders(client);
  const found = again.ok ? again.value[folder] : undefined;
  if (found !== undefined) return { ok: true, value: found };
  return { ok: false, error: { kind: 'imap', reason: created.reason } };
};

/** Why nothing moves to Junk on a server that lists none. */
export const NO_JUNK_FOLDER = 'this mailbox has no Junk folder';

/** Junk exists or it does not: a move there never creates it (`MovableFolder`). */
export const junkFolderName = async (
  client: ImapClient,
): Promise<Result<string, MailConnectionFailure>> => {
  const folders = await resolveFolders(client);
  if (!folders.ok) return folders;
  const { junk } = folders.value;
  if (junk === undefined) return { ok: false, error: { kind: 'error', detail: NO_JUNK_FOLDER } };
  return { ok: true, value: junk };
};
