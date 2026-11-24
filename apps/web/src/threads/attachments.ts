import type { DetectedType, Preview } from '@yozz.app/mail/threads/attachment-content';
import type { Attachment } from '@yozz.app/mail/threads/thread';

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

export const ATTACHMENT_LABEL: Record<Attachment['kind'], string> = {
  pdf: 'PDF',
  image: 'IMG',
  archive: 'ZIP',
  sheet: 'XLS',
  other: 'FILE',
};

/** What the bytes are, named as the chip names a kind. */
const DETECTED_LABEL: Record<DetectedType, string> = {
  'image/png': 'IMG',
  'image/jpeg': 'IMG',
  'image/gif': 'IMG',
  'image/webp': 'IMG',
  'image/avif': 'IMG',
  'application/pdf': 'PDF',
  'application/vnd.microsoft.portable-executable': 'EXE',
  'application/x-executable': 'ELF',
  'application/x-mach-binary': 'MACH-O',
  'application/x-ms-shortcut': 'LNK',
  'text/html': 'HTML',
  'image/svg+xml': 'SVG',
};

/**
 * The chip's tag. A text preview names what a click opens. Otherwise the bytes decide when they
 * identify a type, so a Windows executable labelled `application/pdf` reads `EXE` and a photo sent as
 * `application/octet-stream` reads `IMG`; failing both, the tag is the declared kind.
 */
export const attachmentTag = (
  kind: Attachment['kind'],
  detectedType: DetectedType | null,
  preview: Preview | null,
) => {
  if (preview?.kind === 'text') return 'TXT';
  if (detectedType !== null) return DETECTED_LABEL[detectedType];
  return ATTACHMENT_LABEL[kind];
};
