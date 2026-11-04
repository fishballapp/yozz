import type { Attachment, ThreadState } from '../threads/thread.ts';
import type { DraftRecord, FileReference } from './draft-record.ts';

/**
 * A file on the open draft. Only an `uploaded` one is written to the record, so nothing names a file
 * R2 does not hold; `content` is there on the device that picked it, and fetched elsewhere.
 */
export type DraftFile = Attachment & {
  readonly id: string;
  readonly upload: 'uploading' | 'uploaded' | 'failed' | 'storage-full';
};

/** The draft as the composer holds it, and the record fields it becomes. */
/** What became of an open composer: the human pressed Send, or closed it. */
export type ComposeDraft = {
  /** Recorded at open, not derived from the body, which changes as you type. */
  startedAsReply: boolean;
  /** The address to send as; the address is the identity id. */
  identityId: string;
  to: string;
  /** Free text like `to`. */
  cc: string;
  /** Free text like `to`; SMTP gets it as an envelope recipient only, and the Sent copy names it in a `Bcc` header. */
  bcc: string;
  subject: string;
  /** Markdown source. */
  body: string;
  /** The parent's `References` then the parent itself, oldest first. Absent wherever `inReplyTo` is. */
  references?: readonly string[];
  /** `draftKey` is stable and is what the URL names; `draftId` is the version the next save states. */
  draftKey?: string;
  draftId?: string;
  /** The Message-ID a reply answers; absent on a new message or a forward. */
  inReplyTo?: string;
  /**
   * Which mailbox's Drafts and Sent hold this message. Only a reply has one, and only until it is
   * stored. Carried on the draft because the sending address may have no mailbox of its own.
   */
  ownerAccount?: string;
  /** Sent as `multipart/mixed`. */
  attachments: DraftFile[];
};

/** What an intent starts a draft from. A forwarded message's files have no id until they upload. */
export type ComposeSeed = Omit<Partial<ComposeDraft>, 'attachments'> & {
  attachments?: readonly Attachment[];
};

/** A draft's content without the record store's bookkeeping fields. */
export type DraftContent = Omit<
  DraftRecord,
  'contentVersion' | 'updatedAt' | 'send' | 'unconfirmedSend' | 'sentMessageId' | 'deletedAt'
>;

export const fileReferenceOf = ({ id, name, size, mimeType, kind }: DraftFile): FileReference => ({
  id,
  name,
  size,
  kind,
  ...(mimeType === undefined ? {} : { mimeType }),
});

/** A record's file as the composer holds it: uploaded by whoever attached it, its bytes elsewhere. */
export const draftFileOf = ({ id, name, size, mimeType, kind }: FileReference): DraftFile => ({
  id,
  name,
  size,
  kind,
  upload: 'uploaded',
  ...(mimeType === undefined ? {} : { mimeType }),
});

/** The record fields a composed draft becomes; shared by the autosave and the closing flush. */
export const contentOf = (draft: ComposeDraft, ownerAccount: string | undefined): DraftContent => ({
  from: draft.identityId,
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: draft.body,
  ...(draft.inReplyTo === undefined ? {} : { inReplyTo: draft.inReplyTo }),
  ...(draft.references === undefined ? {} : { references: [...draft.references] }),
  ...(ownerAccount === undefined ? {} : { ownerAccount }),
  // Stated even when empty: an absent list keeps what the record has, and this may be the removal.
  attachments: draft.attachments.filter(({ upload }) => upload === 'uploaded').map(fileReferenceOf),
});

/**
 * Opening a draft is a change to `draft` and would otherwise mint a version, a vault PUT and a
 * mirror refresh for untouched text. Every field the composer can change must be compared here.
 */
export const sameDraftContent = (
  record: DraftRecord,
  content: Omit<DraftRecord, 'contentVersion'>,
): boolean =>
  record.from === content.from &&
  record.ownerAccount === content.ownerAccount &&
  record.to === content.to &&
  record.cc === content.cc &&
  record.bcc === content.bcc &&
  record.subject === content.subject &&
  record.body === content.body &&
  record.inReplyTo === content.inReplyTo &&
  (record.references ?? []).join(' ') === (content.references ?? []).join(' ') &&
  (record.attachments ?? []).map(({ id }) => id).join(' ') ===
    (content.attachments ?? []).map(({ id }) => id).join(' ');

/** A recipient field is free text: commas, semicolons and whitespace all separate. */
export const addressList = (value: string): readonly string[] =>
  value
    .split(/[,;\s]+/)
    .map(address => address.trim())
    .filter(address => address !== '');

/** The sending address's own mailbox when it has a mailbox, else the one holding the conversation. */
export const ownerMailboxFor = (
  threads: readonly ThreadState[],
  inReplyTo: string | undefined,
  from: string,
): string | undefined => {
  if (inReplyTo === undefined) return undefined;
  const thread = threads.find(candidate =>
    candidate.messages.some(message => message.messageId === inReplyTo),
  );
  if (thread === undefined) return undefined;
  return thread.mailboxes.includes(from) ? from : thread.mailboxes[0];
};

/** Gmail's ceiling; base64 adds a third on top. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
