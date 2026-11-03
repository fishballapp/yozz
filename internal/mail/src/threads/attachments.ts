import type { Attachment } from './thread.ts';

/** One classifier for both a picked file and a received MIME part. */
export const attachmentKindOf = (mimeType: string): Attachment['kind'] => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (/zip|tar|compressed/.test(mimeType)) return 'archive';
  if (/sheet|excel|csv/.test(mimeType)) return 'sheet';
  return 'other';
};

/**
 * The type a sender declared, when it is one: a strict `type/subtype`, never parameters or prose,
 * since an agent is shown it as a fact and not as the sender's words.
 */
export const mimeTypeOf = (declared: string | undefined) =>
  declared !== undefined &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu.test(declared)
    ? declared.toLowerCase()
    : 'application/octet-stream';
