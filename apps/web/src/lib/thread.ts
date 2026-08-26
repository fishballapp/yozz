/**
 * The shape of mail as the UI sees it, plus the two helpers every surface reads a thread through.
 * No data lives here; the dev fixtures are `data/mail.ts`, and real mail arrives with IMAP.
 */

/**
 * Mail is not only text. An attachment is a real object here — it has a size and a kind, both of
 * which the reader shows, because "did that contract actually come through, and is it the big one
 * or the summary" is a question you answer from the list and the header, not by downloading.
 */
export type Attachment = {
  name: string;
  /** Bytes. Formatted for display by `formatBytes`. */
  size: number;
  kind: 'pdf' | 'image' | 'archive' | 'sheet' | 'other';
  /** The real media type; absent on fixture data, in which case it is sent as octet-stream. */
  mimeType?: string;
  /** The bytes: read from the picker for a draft, from the fetched message for a received one. */
  content?: Uint8Array<ArrayBuffer>;
};

/**
 * A received body is fetched when the message is OPENED, not when the list syncs: fifty full
 * messages over the relay for a list that shows subjects would be most of the bandwidth for none
 * of the reading. Absent means loaded, so fixtures and sent mail need no state at all.
 */
export type BodyStatus = 'pending' | 'loading' | 'failed';

export type Message = {
  id: string;
  fromName: string;
  fromAddress: string;
  /**
   * The first recipient: one of your addresses when the message arrived here, someone else's when
   * you sent it. `newestInbound` tells the two apart by exactly that.
   */
  toAddress: string;
  /**
   * Every address the envelope's `To` and `Cc` name, lowercased and distinct, in header order —
   * what Reply all offers minus the addresses you own. Absent on fixture data, which has no
   * envelope to read it from.
   */
  recipients?: readonly string[];
  at: number;
  body: string[];
  /**
   * The sender's HTML body, when the message carried one — rendered in `HtmlBody`'s sandboxed
   * frame, with `body` staying the snippet source and the text fallback. Unsanitized here;
   * nothing renders it outside that frame.
   */
  html?: string;
  /**
   * The sender shipped a `text/plain` alternative and `body` is it verbatim. Absent on an
   * HTML message means `body` is our reduction of the HTML: a snippet, not a plain-text view.
   */
  hasTextPart?: boolean;
  /** A CID allocation ceiling left one or more inline images unavailable. */
  inlineImagesTruncated?: boolean;
  bodyStatus?: BodyStatus;
  /** RFC822.SIZE from the summary fetch; checked before requesting the raw message. */
  rawSize?: number;
  /** The RFC 5322 Message-ID, angle brackets included; what a reply's In-Reply-To names. */
  messageId?: string;
  attachments?: Attachment[];
};

export type Thread = {
  id: string;
  /** The address the thread belongs to — the account id IS its address. */
  accountId: string;
  subject: string;
  messages: Message[];
  isUnread: boolean;
  isReplied: boolean;
  isStarred: boolean;
};

/** The four IMAP mailboxes a sync reads. A closed set, so an id can carry one without escaping. */
export type Folder = 'inbox' | 'sent' | 'archive' | 'trash';

export const FOLDERS: readonly Folder[] = ['inbox', 'sent', 'archive', 'trash'];

const isFolder = (value: string): value is Folder => (FOLDERS as readonly string[]).includes(value);

/**
 * `address/folder/uid`, which the URL carries as `/t/jason@example.com/inbox/12` because the
 * thread route is a splat. A message id has the same shape, and a thread's id is its root
 * message's. A uid is only unique within its mailbox, which is why the folder is in the id.
 */
export const threadIdOf = (accountAddress: string, folder: Folder, uid: number) =>
  `${accountAddress}/${folder}/${uid}`;

export const parseThreadId = (
  threadId: string,
): { readonly accountAddress: string; readonly folder: Folder; readonly uid: number } | null => {
  const uidAt = threadId.lastIndexOf('/');
  if (uidAt === -1) return null;
  const folderAt = threadId.lastIndexOf('/', uidAt - 1);
  if (folderAt === -1) return null;
  const folder = threadId.slice(folderAt + 1, uidAt);
  const uid = Number.parseInt(threadId.slice(uidAt + 1), 10);
  if (!isFolder(folder) || Number.isNaN(uid)) return null;
  return { accountAddress: threadId.slice(0, folderAt), folder, uid };
};

/**
 * Where a thread's messages sit. The one derived fact the views and the triage buttons read: a
 * conversation is spread across folders, so a boolean per folder would have to answer for the
 * halves too.
 */
type Foldered = { readonly folders: readonly Folder[] };

/** Archived: something of it is in Archive and nothing is left in the inbox. */
export const isArchived = ({ folders }: Foldered) =>
  folders.includes('archive') && !folders.includes('inbox');

/** In the bin: the WHOLE conversation is there. One deleted message of a live thread is not. */
export const isTrashed = ({ folders }: Foldered) =>
  folders.length > 0 && folders.every(folder => folder === 'trash');

/** Attachments belong to messages, so a thread "has" one when any of its messages does. */
export const attachmentsOf = (thread: Thread) =>
  thread.messages.flatMap(message => message.attachments ?? []);

/**
 * The newest message that actually ARRIVED at one of your addresses.
 *
 * Not the same as the newest message: when you sent the last one, `messages.at(-1)` is yours, and
 * everything that reads "who wrote this / which of my addresses got it" — the reader header, the
 * Reply recipient, the identity Reply sends as — is then wrong in the one way this product cannot
 * afford. Falls back to the newest message for a thread with nothing inbound.
 */
export const newestInbound = (thread: Thread, ownedAddresses: readonly string[]) =>
  thread.messages.findLast(message => ownedAddresses.includes(message.toAddress)) ??
  thread.messages[thread.messages.length - 1];
