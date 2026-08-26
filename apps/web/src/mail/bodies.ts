import { DEFAULT_MAX_LITERAL_BYTES } from '@yozz.app/imap';
import PostalMime from 'postal-mime';
import { attachmentKindOf } from '../lib/mail-format';
import type { Attachment } from '../lib/thread';
import type { MailConnectionFailure, Result } from './connection';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types';
import type { LiveTask } from './live';

export type FetchedBody = {
  readonly paragraphs: string[];
  /** The sender shipped a `text/plain` part and `paragraphs` is it, not a reduction of the HTML. */
  readonly hasTextPart: boolean;
  /** The sender's HTML body, `cid:` images inlined as `data:` URIs. Sanitized at render, not here. */
  readonly html?: string;
  /** True when a CID allocation ceiling left one or more inline images unavailable. */
  readonly inlineImagesTruncated: boolean;
  readonly attachments: Attachment[];
};

// Provider limits are typically below this, but the boundary is ours: RFC822.SIZE is checked
// before BODY.PEEK[] is requested, then the received byte count is checked again before parsing.
const MAX_RAW_MESSAGE_BYTES = DEFAULT_MAX_LITERAL_BYTES;
// Markup beyond this becomes the bounded text fallback. HTML email is layout, not an attachment.
const MAX_HTML_BODY_CODE_UNITS = 2 * 1024 * 1024;
const MAX_RENDERED_HTML_CODE_UNITS = 8 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGE_REFERENCES = 64;
const MAX_HTML_TEXT_DEPTH = 128;
const SAFE_INLINE_IMAGE = new Set<string>(SAFE_INLINE_IMAGE_MIME_TYPES);

/** Block-level tags become paragraph breaks; `br` a line break; everything else is inline. */
const BLOCK = new Set([
  'P',
  'DIV',
  'LI',
  'TR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'UL',
  'OL',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
]);
const DROPPED = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'TEMPLATE']);

const textOf = (node: Node, depth = 0): string => {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (!(node instanceof Element)) return '';
  if (DROPPED.has(node.tagName)) return '';
  if (node.tagName === 'BR') return '\n';
  // Native textContent handles pathological nesting without growing our JavaScript call stack.
  // Below the ceiling, keep the richer paragraph/link reduction.
  const inner =
    depth >= MAX_HTML_TEXT_DEPTH
      ? (() => {
          for (const dropped of node.querySelectorAll('script,style,head,title,template'))
            dropped.remove();
          return (node.textContent ?? '').replace(/\s+/g, ' ');
        })()
      : Array.from(node.childNodes)
          .map(child => textOf(child, depth + 1))
          .join('');
  // A link's destination is part of what the sender wrote; without it "click here" says nothing.
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    const text = inner.trim();
    return href !== '' && text !== '' && text !== href && !href.startsWith('mailto:')
      ? `${text} (${href})`
      : inner;
  }
  return BLOCK.has(node.tagName) ? `\n\n${inner}\n\n` : inner;
};

/** Reduce HTML to the text fallback/snippet without mounting it or allowing document fetches. */
export const htmlToText = (html: string): string =>
  textOf(new DOMParser().parseFromString(html, 'text/html').body);

export const toParagraphs = (text: string): string[] =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '');

/** `btoa` takes a binary string; built in chunks so a large image cannot blow the call stack. */
const toBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
};

/**
 * An HTML body's `cid:` references point at sibling MIME parts. Inlining them as `data:` URIs
 * makes the stored body self-contained: no lifecycle to manage (a blob URL would leak or need
 * revoking), and the frame's CSP can stay `img-src data:` with no network at all.
 */
const inlineCidImages = (
  html: string,
  parts: Awaited<ReturnType<typeof PostalMime.parse>>['attachments'],
): { readonly html: string; readonly truncated: boolean } => {
  let inlinedBytes = 0;
  let inlinedReferences = 0;
  let truncated = false;
  const rendered = parts.reduce((acc, part) => {
    const cid = part.contentId?.replace(/^<|>$/g, '');
    if (cid === undefined || cid === '') return acc;
    // `cid:` is case-insensitive (RFC 2392). Bounded both sides: on the left so `mycid:` never
    // matches, on the right so `cid:chart@x` cannot eat into a sibling `cid:chart@x2`. The
    // replacement is a function so sender-controlled text is never interpreted as `$&` syntax.
    const pattern = new RegExp(
      `(?<![a-z0-9.+-])cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["')\\s>]|$)`,
      'gi',
    );
    const references = Array.from(acc.matchAll(pattern)).length;
    if (references === 0) return acc;
    if (typeof part.content === 'string' || !SAFE_INLINE_IMAGE.has(part.mimeType.toLowerCase())) {
      truncated = true;
      return acc;
    }
    const bytes = new Uint8Array(part.content);
    if (
      inlinedBytes + bytes.byteLength > MAX_INLINE_IMAGE_BYTES ||
      inlinedReferences + references > MAX_INLINE_IMAGE_REFERENCES
    ) {
      truncated = true;
      return acc;
    }
    const dataUri = `data:${part.mimeType.toLowerCase()};base64,${toBase64(bytes)}`;
    const projectedLength = acc.length + references * (dataUri.length - `cid:${cid}`.length);
    if (projectedLength > MAX_RENDERED_HTML_CODE_UNITS) {
      truncated = true;
      return acc;
    }
    inlinedBytes += bytes.byteLength;
    inlinedReferences += references;
    return acc.replace(pattern, () => dataUri);
  }, html);
  return { html: rendered, truncated };
};

export const parseBody = async (raw: Uint8Array): Promise<FetchedBody> => {
  if (raw.byteLength > MAX_RAW_MESSAGE_BYTES)
    throw new Error('Message is too large to open safely');
  const mail = await PostalMime.parse(raw);
  // The text part (or the reduction) stays even when HTML renders: it is the snippet and, one
  // day, the search source — and the fallback wherever the frame cannot mount.
  const senderText = mail.text?.trim() ? mail.text : null;
  const text =
    senderText ??
    (mail.html !== undefined ? htmlToText(mail.html.slice(0, MAX_HTML_BODY_CODE_UNITS)) : '');
  const attachments = mail.attachments
    // A `cid:`-referenced part is an HTML body's image, not a file the sender attached.
    .filter(part => part.related !== true)
    .map(part => {
      // `content` is a string only under `attachmentEncoding: 'base64'`, which is never set here;
      // the branch exists to satisfy the type. `slice()` makes the `ArrayBuffer`-backed copy
      // `Blob` can take.
      const content =
        typeof part.content === 'string'
          ? new TextEncoder().encode(part.content)
          : new Uint8Array(part.content).slice();
      return {
        name: part.filename ?? 'attachment',
        size: content.byteLength,
        kind: attachmentKindOf(part.mimeType),
        mimeType: part.mimeType,
        content,
      };
    });
  const inlinedHtml =
    mail.html?.trim() && mail.html.length <= MAX_HTML_BODY_CODE_UNITS
      ? inlineCidImages(mail.html, mail.attachments)
      : null;
  return {
    paragraphs: toParagraphs(text),
    hasTextPart: senderText !== null,
    // A present-but-blank or oversized HTML part falls through to text, not to an empty or
    // attacker-sized frame. CID expansion has a second, post-replacement ceiling of its own.
    ...(inlinedHtml === null ? {} : { html: inlinedHtml.html }),
    inlineImagesTruncated: inlinedHtml?.truncated ?? false,
    attachments,
  };
};

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/** Fetch one message body on the account's live connection. */
export const fetchBody = async (
  run: Run,
  /** The IMAP mailbox name the uid belongs to, from the folder's sync mark. */
  mailbox: string,
  uid: number,
  expectedRawSize: number | undefined,
): Promise<Result<FetchedBody, MailConnectionFailure>> => {
  if (
    expectedRawSize !== undefined &&
    (!Number.isSafeInteger(expectedRawSize) || expectedRawSize < 0)
  )
    return {
      ok: false,
      error: { kind: 'error', detail: 'Message size is unavailable' },
    };
  if (expectedRawSize !== undefined && expectedRawSize > MAX_RAW_MESSAGE_BYTES)
    return {
      ok: false,
      error: { kind: 'error', detail: 'Message is too large to open safely' },
    };
  return run({
    priority: 'user',
    retry: true,
    run: async client => {
      const selectRes = await client.ensureSelected(mailbox);
      if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
      const rawRes = await client.fetchRaw(uid);
      if (!rawRes.ok) return { ok: false, error: { kind: 'imap', reason: rawRes.reason } };
      try {
        return { ok: true, value: await parseBody(rawRes.value) };
      } catch (error) {
        return {
          ok: false,
          error: { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  });
};
