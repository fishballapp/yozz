import type { Attachment, Message } from './thread';
import { fullTime } from './time';

/** Attachment sizes are machine values: short, unpadded, and never more than one decimal. */
export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  // The exponent is chosen before the mantissa is rounded, so 1_048_575 lands at 1023.999 KB and
  // prints "1024 KB". Carry into the next unit when rounding pushes it back to the boundary.
  const raw = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  const rounded = bytes / 1024 ** raw;
  const carries = Math.round(rounded) >= 1024 && raw < units.length;
  const exponent = carries ? raw + 1 : raw;
  const value = bytes / 1024 ** exponent;
  const unit = units[exponent - 1] ?? 'GB';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
};

/** One classifier for both a picker `File` and a received MIME part. */
export const attachmentKindOf = (mimeType: string): Attachment['kind'] => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (/zip|tar|compressed/.test(mimeType)) return 'archive';
  if (/sheet|excel|csv/.test(mimeType)) return 'sheet';
  return 'other';
};

export const ATTACHMENT_LABEL: Record<Attachment['kind'], string> = {
  pdf: 'PDF',
  image: 'IMG',
  archive: 'ZIP',
  sheet: 'XLS',
  other: 'FILE',
};

/**
 * Build the quoted original for a reply.
 *
 * Markdown's blockquote is `>`, which is the same character mail has used for quoting since before
 * markdown existed — so the draft reads correctly as plain text, renders correctly in the preview,
 * and survives to a recipient whose client only takes text. The attribution line above it is the
 * convention every mail client already writes.
 */
export const quoteForReply = (message: Message) =>
  [
    '',
    '',
    `On ${fullTime(message.at)}, ${message.fromName} <${message.fromAddress}> wrote:`,
    '',
    // `>` separates paragraphs, so it belongs BETWEEN them — appending one per paragraph and
    // trying to strip the last leaves a bare `>` on the final line of every draft.
    ...message.body.flatMap((paragraph, index) =>
      index === 0 ? [`> ${paragraph}`] : ['>', `> ${paragraph}`],
    ),
  ].join('\n');
