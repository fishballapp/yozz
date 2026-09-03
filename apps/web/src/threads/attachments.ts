import type { Attachment } from '../threads/thread';

/** Short, unpadded, never more than one decimal. */
export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  // The exponent is chosen before rounding, so 1_048_575 would print "1024 KB"; carry into the next unit.
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
