import { type Preview, savedName } from '@yozz.app/mail/threads/attachment-content';
import type { Attachment } from '@yozz.app/mail/threads/thread';

/**
 * The one boundary between a received attachment's bytes and the browser: the blob URLs. What may
 * preview, and what the bytes are, is decided in `@yozz.app/mail/threads/attachment-content`, which
 * every client shares. Every object URL made here carries a type read from the bytes, never the
 * sender's, and `html:security` proves in all three engines what each one becomes.
 */

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
  anchor.download = savedName(file.name);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
