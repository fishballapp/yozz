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
  /**
   * The `References` chain this message arrived with, oldest first. Kept per message rather than
   * derived from the thread: a reply must send the chain its PARENT carried plus that parent, and
   * a thread's own order is our grouping's opinion, not what the other client will thread on.
   * Absent on fixture data.
   */
  references?: readonly string[];
  /**
   * Every physical copy of this message on a server. Every IMAP command (a body fetch, a flag
   * write, a move) addresses one of these; nothing else does, because a copy's uid changes on
   * every move while `id` does not. Absent on fixture data, which is never on a server.
   *
   * A list rather than one locator because the same RFC message can sit in more than one place
   * once threads span accounts: two people copied on one mail hold a copy each, and they are one
   * message on screen.
   */
  locations?: readonly Location[];
  attachments?: Attachment[];
  /**
   * An unsent draft, shown in its conversation the way a mail client shows one. It has no copy on
   * any server that this client owns, so it is skipped by moves, flag writes and body fetches —
   * `locations` is empty and its text is already here.
   */
  isDraft?: boolean;
  /** The vault record behind a draft message: what opens it, and what a tool names to write it. */
  draftKey?: string;
  draftId?: string;
};

export type Thread = {
  id: string;
  /**
   * Every account holding some of this conversation, in address order. A thread is ONE object
   * everywhere: opening it in one account's view shows all of it, including what another account
   * holds, because that is what the conversation is.
   */
  accounts: readonly string[];
  subject: string;
  messages: Message[];
  isUnread: boolean;
  isReplied: boolean;
  isStarred: boolean;
};

/**
 * One physical copy of a message. `uidValidity` rides along because a uid means nothing without
 * it: a server may renumber a mailbox, and a write aimed at a stale uid would hit whatever now
 * holds that number.
 */
export type Location = {
  readonly account: string;
  readonly folder: Folder;
  readonly uidValidity: number;
  readonly uid: number;
};

/** The IMAP mailboxes a sync reads. A closed set, so an id can carry one without escaping. */
export type Folder = 'inbox' | 'sent' | 'archive' | 'trash' | 'drafts';

export const FOLDERS: readonly Folder[] = ['inbox', 'sent', 'archive', 'trash', 'drafts'];

/**
 * A message's id, and through its root a thread's: `mid/<Message-ID>` when that Message-ID names
 * exactly one displayed message across every account, else the physical form below.
 *
 * NO account prefix. A conversation spans accounts, and the same mail delivered to two of your
 * addresses is ONE message on screen — an id naming an account would have to pick one of them,
 * and would change if that were the copy deleted. The Message-ID form is also what survives a
 * move: an archive gives a copy a new uid in a new folder, and a URL, an agent's handle or a
 * pending op that named it must still resolve after. The URL carries it as a splat, so
 * `/t/mid/<abc@example.com>` reads as typed and the router percent-encodes the brackets.
 */
export const messageIdOf = (messageId: string) => `mid/${messageId}`;

/**
 * A draft's id, and a draft-only thread's. Keyed by the vault record, never by a Message-ID: a
 * draft has none until it is sent, and the mirror's changing ids are not the draft.
 */
export const draftIdOf = (draftKey: string) => `draft/${draftKey}`;

/**
 * The thread a handle names: its own id, or the id of ANY message in it.
 *
 * A thread is named by its earliest message, and which message that is can change — an older one
 * backfilled by paging becomes the new root. Accepting any member means an id somebody wrote down
 * a minute ago still opens the conversation it came from.
 */
export const threadByHandle = <T extends { id: string; messages: readonly { id: string }[] }>(
  threads: readonly T[],
  handle: string,
): T | null =>
  threads.find(thread => thread.id === handle) ??
  threads.find(thread => thread.messages.some(message => message.id === handle)) ??
  null;

/**
 * The fallback, for mail with no Message-ID or a Message-ID two different messages share: one
 * physical copy names the message. A uid means nothing outside its own mailbox, nor across a
 * renumbering, so the account, the folder and the UIDVALIDITY are all in it. Such an id changes
 * when that copy MOVES, which is why it is the fallback — mail without a Message-ID is rare
 * (RFC 5322 says SHOULD).
 */
export const physicalIdOf = ({ account, folder, uidValidity, uid }: Location) =>
  `${account}/${folder}/${uidValidity}/${uid}`;

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
