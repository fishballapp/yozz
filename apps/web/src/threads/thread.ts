/** The shape of mail as the UI sees it. Dev fixtures are `data/mail.ts`; real mail arrives with IMAP. */

export type Attachment = {
  name: string;
  /** Bytes; formatted by `formatBytes`. */
  size: number;
  kind: 'pdf' | 'image' | 'archive' | 'sheet' | 'other';
  /** Absent on fixture data, in which case it is sent as octet-stream. */
  mimeType?: string;
  /** Read from the picker for a draft, from the fetched message for a received one. */
  content?: Uint8Array<ArrayBuffer>;
};

/** Someone on a `To` or `Cc` line, as the sender wrote them. */
export type Recipient = { readonly name?: string; readonly address: string };

/** A received body is fetched when the message is opened. Absent means loaded. */
export type BodyStatus = 'pending' | 'loading' | 'failed';

export type Message = {
  id: string;
  fromName: string;
  fromAddress: string;
  /** The first recipient: one of your addresses when the message arrived here. `newestInbound` tells the two apart. */
  toAddress: string;
  /** `To` and `Cc` as the sender wrote them, in header order. Absent on a draft. */
  to?: readonly Recipient[];
  cc?: readonly Recipient[];
  /** Where the sender wants replies to go, present only when it names someone other than From. */
  replyTo?: readonly Recipient[];
  at: number;
  body: string[];
  /** The sender's HTML body, unsanitized; nothing renders it outside `HtmlBody`'s sandboxed frame. */
  html?: string;
  /** `body` is the sender's `text/plain` part verbatim. Absent on an HTML message means `body` is our reduction. */
  hasTextPart?: boolean;
  /** A CID allocation ceiling left one or more inline images unavailable. */
  inlineImagesTruncated?: boolean;
  bodyStatus?: BodyStatus;
  /** RFC822.SIZE from the summary fetch; checked before requesting the raw message. */
  rawSize?: number;
  /** The RFC 5322 Message-ID, angle brackets included. */
  messageId?: string;
  /** The `References` chain this message arrived with, oldest first; a reply sends its parent's chain plus the parent. */
  references?: readonly string[];
  /**
   * Every physical copy on a server; every IMAP command addresses one of these, since a copy's uid
   * changes on every move while `id` does not. A list because one message can sit in two accounts
   * once threads span them.
   */
  locations?: readonly Location[];
  attachments?: Attachment[];
  /** An unsent draft: `locations` is empty, so moves, flag writes and body fetches skip it. */
  isDraft?: boolean;
  /** The vault record behind a draft message. */
  draftKey?: string;
  draftId?: string;
};

/** `Message.body` from text: blank lines part paragraphs, a single line break stays inside one. */
export const toParagraphs = (text: string): string[] =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '');

export type Thread = {
  id: string;
  /** Every account holding some of this conversation, in address order. */
  accounts: readonly string[];
  subject: string;
  messages: Message[];
  isUnread: boolean;
  isReplied: boolean;
  isStarred: boolean;
};

/** One physical copy. `uidValidity` rides along because a uid means nothing without it. */
export type Location = {
  readonly account: string;
  readonly folder: Folder;
  readonly uidValidity: number;
  readonly uid: number;
};

/** The IMAP mailboxes a sync reads. A closed set, so an id can carry one. */
export type Folder = 'inbox' | 'sent' | 'archive' | 'trash' | 'drafts';

export const FOLDERS: readonly Folder[] = ['inbox', 'sent', 'archive', 'trash', 'drafts'];

/**
 * `mid/<Message-ID>` when that Message-ID names exactly one displayed message across every account,
 * else the physical form below. No account prefix, and the form survives a move; see DECISIONS.md.
 * The URL carries it as a splat, so `/t/mid/<abc@example.com>` reads as typed.
 */
export const messageIdOf = (messageId: string) => `mid/${messageId}`;

/** Keyed by the vault record, never a Message-ID: a draft has none until sent. */
export const draftIdOf = (draftKey: string) => `draft/${draftKey}`;

/** Its own id, or the id of any message in it: the root can change when paging backfills an older message. */
export const threadByHandle = <T extends { id: string; messages: readonly { id: string }[] }>(
  threads: readonly T[],
  handle: string,
): T | null =>
  threads.find(thread => thread.id === handle) ??
  threads.find(thread => thread.messages.some(message => message.id === handle)) ??
  null;

/** The fallback for mail with no unique Message-ID: one physical copy, which changes when that copy moves. */
export const physicalIdOf = ({ account, folder, uidValidity, uid }: Location) =>
  `${account}/${folder}/${uidValidity}/${uid}`;

/** Where a thread's messages sit; a conversation is spread across folders. */
type Foldered = { readonly folders: readonly Folder[] };

/** Something of it is in Archive and nothing is left in the inbox. */
export const isArchived = ({ folders }: Foldered) =>
  folders.includes('archive') && !folders.includes('inbox');

/** The whole conversation is in Trash. */
export const isTrashed = ({ folders }: Foldered) =>
  folders.length > 0 && folders.every(folder => folder === 'trash');

/** A thread has an attachment when any of its messages does. */
export const attachmentsOf = (thread: Thread) =>
  thread.messages.flatMap(message => message.attachments ?? []);

/**
 * RFC 9051's UIDVALIDITY is a non-zero number, so 0 marks a copy no server holds: sent mail kept in
 * the vault because its address has no mailbox to keep it in.
 */
export const VAULT_UID_VALIDITY = 0;

/**
 * The accounts a message arrived at, once each. Empty for mail you sent, unless another of your
 * addresses received it too. The account that sent it is never an arrival, which keeps a deleted
 * Sent copy, now in Trash, from reading as received.
 */
export const inboxesOf = (message: Message): readonly string[] => [
  ...new Set(
    (message.locations ?? [])
      .filter(
        ({ account, folder }) =>
          folder !== 'sent' && account.toLowerCase() !== message.fromAddress.toLowerCase(),
      )
      .map(({ account }) => account),
  ),
];

/**
 * Gmail's "to me, Alice": To then Cc as one list, once per address, with every address you own read
 * as a single "me". Empty when nobody is named, which is the Bcc's `undisclosed-recipients:;`.
 */
export const addresseesOf = (
  message: Message,
  ownedAddresses: readonly string[],
): readonly (Recipient | 'me')[] => {
  const owned = new Set(ownedAddresses.map(address => address.toLowerCase()));
  const byKey = new Map<string, Recipient | 'me'>();
  for (const recipient of [...(message.to ?? []), ...(message.cc ?? [])]) {
    const address = recipient.address.toLowerCase();
    const key = owned.has(address) ? 'me' : address;
    if (!byKey.has(key)) byKey.set(key, key === 'me' ? 'me' : recipient);
  }
  return [...byKey.values()];
};

/** The newest message that arrived at one of your addresses; `messages.at(-1)` may be yours. Falls back to the newest. */
export const newestInbound = (thread: Thread, ownedAddresses: readonly string[]) =>
  thread.messages.findLast(message => ownedAddresses.includes(message.toAddress)) ??
  thread.messages[thread.messages.length - 1];

/** A thread as a mailbox sees it: which folders it occupies, and the questions the views ask of that. */
export type ThreadState = Thread & {
  /** Every mailbox this conversation occupies, across all accounts. */
  readonly folders: readonly Folder[];
  /** Per account: an address's view is a predicate over one account's copies. */
  readonly foldersByAccount: Readonly<Record<string, readonly Folder[]>>;
};
