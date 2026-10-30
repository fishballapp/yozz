import type { Attachment } from './thread.ts';

/** One classifier for both a picked file and a received MIME part. */
export const attachmentKindOf = (mimeType: string): Attachment['kind'] => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (/zip|tar|compressed/.test(mimeType)) return 'archive';
  if (/sheet|excel|csv/.test(mimeType)) return 'sheet';
  return 'other';
};
