import { SAFE_INLINE_IMAGE_MIME_TYPES } from '@yozz.app/mail/threads/image-types';
import type { Attachment } from '@yozz.app/mail/threads/thread';

/**
 * The one boundary between a received attachment's bytes and the browser. An attachment previews
 * only when the sender's label (or, under a generic label, the file's extension) AND the bytes agree
 * on a kind that cannot become a document with script (DECISIONS.md, 2026-10-15): a raster image,
 * plain text or a PDF. Everything else, HTML and SVG included, is a download. Every object URL made
 * here carries a type read from the bytes, never the sender's, and `html:security` proves in all
 * three engines what each one becomes.
 */

type SafeImageType = 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

export type Preview =
  | { readonly kind: 'image'; readonly mimeType: SafeImageType }
  | { readonly kind: 'text' }
  | { readonly kind: 'pdf' };

/**
 * Text above this does not preview: one `<pre>` of a 30 MB log takes seconds to lay out, and a
 * file that size is a download anyway. Images and PDFs have no cap of their own; the 32 MiB message
 * ceiling already bounds them.
 */
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** What a specific label claims. Text is kept to what is worth reading as text, never parsed. */
const KIND_BY_LABEL = new Map<string, Preview['kind']>([
  ...SAFE_INLINE_IMAGE_MIME_TYPES.map(type => [type, 'image'] as const),
  ['application/pdf', 'pdf'],
  ['text/plain', 'text'],
  ['text/csv', 'text'],
  ['text/markdown', 'text'],
]);

/**
 * Many clients label every attachment this way, or not at all. Only under such a label does the
 * extension propose a kind; a specific label that disagrees with the bytes still means no preview.
 */
const GENERIC_LABELS = new Set(['application/octet-stream', '']);

const KIND_BY_EXTENSION = new Map<string, Preview['kind']>([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].map(extension => [extension, 'image'] as const),
  ['pdf', 'pdf'],
  ...['txt', 'log', 'csv', 'md'].map(extension => [extension, 'text'] as const),
]);

const ascii = (text: string) => Array.from(text, character => character.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

/**
 * A real `ftyp` box is a major brand, a minor version and a handful of compatible brands, a few dozen
 * bytes. One declaring more is not an image header, and reading it as one would walk a crafted
 * attachment's whole length during render.
 */
const MAX_FTYP_BOX_BYTES = 256;
const FTYP = ascii('ftyp');
const AVIF_BRANDS = [ascii('avif'), ascii('avis')];

/** An ISO-BMFF `ftyp` box naming AVIF as its major brand or among its compatible ones. */
const isAvif = (bytes: Uint8Array) => {
  if (bytes.length < 16 || !startsWith(bytes, FTYP, 4)) return false;
  const boxEnd = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (boxEnd < 16 || boxEnd > MAX_FTYP_BOX_BYTES || boxEnd > bytes.length) return false;
  // Offset 8 is the major brand and 12 the minor version, which is not a brand; the compatible
  // brands follow from 16.
  for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
    if (offset !== 12 && AVIF_BRANDS.some(brand => startsWith(bytes, brand, offset))) return true;
  }
  return false;
};

/** Magic numbers, so a part labelled `image/png` that holds HTML or SVG never reaches an `<img>`. */
const RASTER_SIGNATURES: readonly (readonly [SafeImageType, (bytes: Uint8Array) => boolean])[] = [
  ['image/png', bytes => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', bytes => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ['image/gif', bytes => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))],
  ['image/webp', bytes => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)],
  ['image/avif', isAvif],
];

const sniffRaster = (bytes: Uint8Array): SafeImageType | null =>
  RASTER_SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null;

const isUtf16 = (bytes: Uint8Array) =>
  startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);

/** Git's heuristic: a NUL in the first 8000 bytes is a binary file wearing a text label. */
const looksLikeText = (bytes: Uint8Array) => isUtf16(bytes) || !bytes.subarray(0, 8000).includes(0);

/** The kind the sender's label claims, or under a generic label the one the extension does. */
const claimedKind = (name: string, mimeType: string | undefined) => {
  const label = mimeType?.toLowerCase() ?? '';
  if (!GENERIC_LABELS.has(label)) return KIND_BY_LABEL.get(label);
  // The name as shown and saved, bidi controls removed, so the claim is the saved file's extension.
  const extension = /\.([^.]+)$/.exec(displayName(name))?.[1]?.toLowerCase();
  return extension === undefined ? undefined : KIND_BY_EXTENSION.get(extension);
};

/** What the chip may open, or `null` for a download only. The bytes must agree with the claim. */
export const previewOf = ({ name, mimeType, content }: Attachment): Preview | null => {
  if (content === undefined) return null;
  switch (claimedKind(name, mimeType)) {
    case 'image': {
      // The bytes name the type, so a PNG labelled `image/jpeg` still previews, as a PNG.
      const sniffed = sniffRaster(content);
      return sniffed === null ? null : { kind: 'image', mimeType: sniffed };
    }
    case 'pdf':
      return startsWith(content, ascii('%PDF-')) ? { kind: 'pdf' } : null;
    case 'text':
      return content.byteLength <= MAX_TEXT_PREVIEW_BYTES && looksLikeText(content)
        ? { kind: 'text' }
        : null;
    case undefined:
      return null;
  }
};

/**
 * UTF-8 unless a UTF-16 byte order mark says otherwise. Postal-mime does not hand an attachment's
 * charset over, so a Latin-1 file shows replacement marks: legible enough, and the download is exact.
 */
export const decodeText = (bytes: Uint8Array): string => {
  const encoding = (() => {
    if (startsWith(bytes, [0xff, 0xfe])) return 'utf-16le';
    if (startsWith(bytes, [0xfe, 0xff])) return 'utf-16be';
    return 'utf-8';
  })();
  return new TextDecoder(encoding).decode(bytes);
};

/**
 * Bidi controls removed, so `invoice\u202efdp.exe` reads as the `.exe` it is rather than
 * `invoiceexe.pdf`. `dir="auto"` only isolates a name from its neighbours; an override inside it
 * still reorders the name itself.
 */
export const displayName = (name: string) =>
  name.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');

/** An object URL whose type was read from the bytes. The caller revokes it. */
export const objectUrlFor = (
  content: Uint8Array<ArrayBuffer>,
  preview: Extract<Preview, { kind: 'image' | 'pdf' }>,
) =>
  URL.createObjectURL(
    new Blob([content], { type: preview.kind === 'pdf' ? 'application/pdf' : preview.mimeType }),
  );

/**
 * Saves the bytes under the sender's name, bidi controls removed. `download` is what makes it a save
 * in every engine; the `application/octet-stream` type only spares Firefox if it were ignored, since
 * WebKit renders such a blob as HTML (DECISIONS.md, 2026-10-15). The URL is revoked once the click
 * has been handed off.
 */
export const download = (file: Attachment) => {
  if (file.content === undefined) return;
  const url = URL.createObjectURL(new Blob([file.content], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = displayName(file.name);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
