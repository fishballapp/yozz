import type { ImapClient, ImapMailbox } from '@yozz.app/imap';
import type { Folder } from '../lib/thread';
import type { MailConnectionFailure, Result } from './connection';

/** RFC 6154 names the folder; servers without SPECIAL-USE mostly agree on how they spell it. */
const SENT_MAILBOX_NAMES = new Set(['sent', 'sent items', 'sent messages', 'sent mail']);
const ARCHIVE_MAILBOX_NAMES = new Set(['archive', 'archives']);
/** Gmail's is under its own namespace; `Draft` singular is Exchange's. */
const DRAFTS_MAILBOX_NAMES = new Set(['drafts', '[gmail]/drafts', 'draft']);
const TRASH_MAILBOX_NAMES = new Set([
  'trash',
  'deleted',
  'deleted items',
  'deleted messages',
  'bin',
]);

/** The folders a move can create. `INBOX` is reserved; Sent only ever receives copies. */
type MovableFolder = Extract<Folder, 'archive' | 'trash'>;

/** What one is called when the server has none and a move has to make it. */
const CREATED_NAME: Record<MovableFolder, string> = { archive: 'Archive', trash: 'Trash' };

const specialUseOf = (
  listed: readonly ImapMailbox[],
  attribute: string,
  names: ReadonlySet<string>,
) =>
  listed.find(mailbox => mailbox.attributes.some(a => a.toLowerCase() === attribute)) ??
  listed.find(mailbox => names.has(mailbox.name.toLowerCase()));

/**
 * The IMAP name behind each folder: `INBOX` is reserved by the protocol; Sent, Archive and Trash
 * are whichever mailbox `LIST` marks with the matching special-use attribute, else the usual
 * names, else absent — a sync never creates them; only a move does, and only the one it needs.
 */
export const resolveFolders = async (
  client: ImapClient,
): Promise<Result<Partial<Record<Folder, string>>, MailConnectionFailure>> => {
  const listed = await client.list('', '*');
  if (!listed.ok) return { ok: false, error: { kind: 'imap', reason: listed.reason } };
  const sent = specialUseOf(listed.value, '\\sent', SENT_MAILBOX_NAMES);
  const archive = specialUseOf(listed.value, '\\archive', ARCHIVE_MAILBOX_NAMES);
  const trash = specialUseOf(listed.value, '\\trash', TRASH_MAILBOX_NAMES);
  const drafts = specialUseOf(listed.value, '\\drafts', DRAFTS_MAILBOX_NAMES);
  return {
    ok: true,
    value: {
      inbox: 'INBOX',
      ...(sent === undefined ? {} : { sent: sent.name }),
      ...(archive === undefined ? {} : { archive: archive.name }),
      ...(trash === undefined ? {} : { trash: trash.name }),
      ...(drafts === undefined ? {} : { drafts: drafts.name }),
    },
  };
};

/** Resolve a destination mailbox, creating it when LIST has none. Used by moves only. */
export const ensureMailbox = async (
  client: ImapClient,
  folder: MovableFolder,
): Promise<Result<string, MailConnectionFailure>> => {
  const folders = await resolveFolders(client);
  if (!folders.ok) return folders;
  const resolved = folders.value[folder];
  if (resolved !== undefined) return { ok: true, value: resolved };
  const name = CREATED_NAME[folder];
  const created = await client.create(name);
  if (!created.ok) return { ok: false, error: { kind: 'imap', reason: created.reason } };
  return { ok: true, value: name };
};
