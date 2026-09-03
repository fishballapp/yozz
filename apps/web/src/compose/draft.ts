import { attachmentKindOf } from '../threads/attachments';
import type { Attachment, ThreadState } from '../threads/thread';
import type { DraftRecord } from './draft-record';

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
  /** Free text like `to`; reaches the envelope only (`buildMessage` writes no `Bcc` header). */
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
   * Which account's Drafts and Sent hold this message. Only a reply has one, and only until it is
   * stored. Carried on the draft because the sending address may have no mailbox of its own.
   */
  ownerAccount?: string;
  /** Picker files with their bytes read, or a forwarded message's; sent as `multipart/mixed`. */
  attachments: Attachment[];
};

/** A draft's content without the record store's bookkeeping fields. */
export type DraftContent = Omit<
  DraftRecord,
  'contentVersion' | 'updatedAt' | 'send' | 'unconfirmedSend' | 'sentMessageId' | 'deletedAt'
>;

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
  (record.references ?? []).join(' ') === (content.references ?? []).join(' ');

/** A recipient field is free text: commas, semicolons and whitespace all separate. */
export const addressList = (value: string): readonly string[] =>
  value
    .split(/[,;\s]+/)
    .map(address => address.trim())
    .filter(address => address !== '');

/** The sending address's own account when it has a mailbox, else the one holding the conversation. */
export const ownerAccountFor = (
  threads: readonly ThreadState[],
  inReplyTo: string | undefined,
  from: string,
): string | undefined => {
  if (inReplyTo === undefined) return undefined;
  const thread = threads.find(candidate =>
    candidate.messages.some(message => message.messageId === inReplyTo),
  );
  if (thread === undefined) return undefined;
  return thread.accounts.includes(from) ? from : thread.accounts[0];
};

/** Three outcomes: "went out but the copy did not" is neither a success nor a retryable failure. */
export type SendReport =
  | { readonly state: 'sent' }
  | { readonly state: 'sent-with-caveat'; readonly detail: string }
  | { readonly state: 'refused'; readonly detail: string; readonly draftKey: string }
  /** The machine threw rather than answering, so this cannot say whether the message went out. */
  | { readonly state: 'unsettled'; readonly detail: string };

/** Picker files with their bytes read, so a send never snapshots a draft mid-read. */
export const readAttachments = (files: readonly File[]): Promise<Attachment[]> =>
  Promise.all(
    files.map(async file => ({
      name: file.name,
      size: file.size,
      kind: attachmentKindOf(file.type),
      mimeType: file.type === '' ? undefined : file.type,
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
