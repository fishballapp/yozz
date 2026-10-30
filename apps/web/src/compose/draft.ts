import { attachmentKindOf } from '@yozz.app/mail/threads/attachments';
import type { Attachment } from '@yozz.app/mail/threads/thread';

/** Three outcomes: "went out but the copy did not" is neither a success nor a retryable failure. */
export type SendReport =
  | { readonly state: 'sent' }
  | { readonly state: 'sent-with-caveat'; readonly detail: string }
  | { readonly state: 'refused'; readonly detail: string; readonly draftKey: string }
  /** The machine threw rather than answering, so this cannot say whether the message went out. */
  | { readonly state: 'unsettled'; readonly detail: string }
  /** The session that sent it ended first; the outcome is that user's, and the next unlock shows it. */
  | { readonly state: 'ended' };

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
