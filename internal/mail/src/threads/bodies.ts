import { DEFAULT_MAX_LITERAL_BYTES } from '@yozz.app/imap';
import { type DefaultTreeAdapterTypes, html, parse } from 'parse5';
import PostalMime from 'postal-mime';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import { attachmentKindOf } from './attachments.ts';
import type { MailHeader } from './authentication-results.ts';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types.ts';
import { type Attachment, toParagraphs } from './thread.ts';

export type FetchedBody = {
  readonly paragraphs: string[];
  /** `paragraphs` is the sender's `text/plain` part, not a reduction of the HTML. */
  readonly hasTextPart: boolean;
  /** `cid:` images inlined as `data:` URIs. Sanitized at render, not here. */
  readonly html?: string;
  /** A CID allocation ceiling left one or more inline images unavailable. */
  readonly inlineImagesTruncated: boolean;
  readonly attachments: Attachment[];
  /**
   * `From` and `Authentication-Results`, top to bottom: whether the sender is authenticated depends
   * on the account that received the copy, so it is decided where the account is known.
   */
  readonly senderHeaders: readonly MailHeader[];
};

const SENDER_HEADERS = new Set(['from', 'authentication-results']);

// RFC822.SIZE is checked before BODY.PEEK[], then the received byte count again before parsing.
const MAX_RAW_MESSAGE_BYTES = DEFAULT_MAX_LITERAL_BYTES;
// Markup beyond this becomes the bounded text fallback.
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

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

const isElement = (node: ChildNode): node is Element => 'tagName' in node;
const isText = (node: ChildNode): node is DefaultTreeAdapterTypes.TextNode =>
  node.nodeName === '#text';

/** The DOM's `tagName`: upper-case for an HTML element, as written for SVG and MathML. */
const tagNameOf = (element: Element) =>
  element.namespaceURI === html.NS.HTML ? element.tagName.toUpperCase() : element.tagName;

/**
 * Never text, in any namespace: an SVG `<style>` is CSS and its `<title>` a tooltip, as much as
 * their HTML namesakes are.
 */
const isDropped = (element: Element) => DROPPED.has(element.tagName.toUpperCase());

/** Every text node below `root` in document order, without recursion, skipping what `isDropped` names. */
const flatTextOf = (root: Element): string => {
  const parts: string[] = [];
  const pending = root.childNodes.toReversed();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isText(node)) parts.push(node.value);
    if (isElement(node) && !isDropped(node)) {
      for (const child of node.childNodes.toReversed()) pending.push(child);
    }
  }
  return parts.join('');
};

const textOf = (node: ChildNode, depth = 0): string => {
  if (isText(node)) return node.value.replace(/\s+/g, ' ');
  if (!isElement(node) || isDropped(node)) return '';
  const tagName = tagNameOf(node);
  if (tagName === 'BR') return '\n';
  // Past this depth, a flat walk handles pathological nesting without growing the call stack.
  const inner =
    depth >= MAX_HTML_TEXT_DEPTH
      ? flatTextOf(node).replace(/\s+/g, ' ')
      : node.childNodes.map(child => textOf(child, depth + 1)).join('');
  // Without the destination "click here" says nothing.
  if (tagName === 'A') {
    const href = node.attrs.find(attribute => attribute.name === 'href')?.value ?? '';
    const text = inner.trim();
    return href !== '' && text !== '' && text !== href && !href.startsWith('mailto:')
      ? `${text} (${href})`
      : inner;
  }
  return BLOCK.has(tagName) ? `\n\n${inner}\n\n` : inner;
};

/**
 * Reduce HTML to text without mounting it or fetching anything. parse5 runs the HTML parsing
 * algorithm a browser's `DOMParser` does, scripting off as `DOMParser`'s is, so the tree is the same
 * in Node and the browser.
 */
export const htmlToText = (markup: string): string => {
  const root = parse(markup, { scriptingEnabled: false }).childNodes.find(isElement);
  // `Document.body`: the root's first `<body>` or `<frameset>`, whose `<noframes>` is the fallback.
  const body = root?.childNodes.find(
    (node): node is Element =>
      isElement(node) && (node.tagName === 'body' || node.tagName === 'frameset'),
  );
  return body === undefined ? '' : textOf(body);
};

/** `btoa` takes a binary string; chunked so a large image cannot blow the call stack. */
const toBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
};

/** `data:` URIs make the stored body self-contained (no blob URL lifecycle) and keep the frame's CSP at `img-src data:`. */
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
    // `cid:` is case-insensitive (RFC 2392). Bounded both sides so `mycid:` and `cid:chart@x2` do not
    // match; a replacement function so sender text is never read as `$&` syntax.
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
  if (raw.byteLength > MAX_RAW_MESSAGE_BYTES) {
    throw new Error('Message is too large to open safely');
  }
  const mail = await PostalMime.parse(raw);
  // The text part stays even when HTML renders: it is the snippet and the fallback.
  const senderText = mail.text?.trim() ? mail.text : null;
  const text =
    senderText ??
    (mail.html !== undefined ? htmlToText(mail.html.slice(0, MAX_HTML_BODY_CODE_UNITS)) : '');
  const attachments = mail.attachments
    // A `cid:`-referenced part is an HTML body's image, not an attachment.
    .filter(part => part.related !== true)
    .map(part => {
      // `content` is a string only under `attachmentEncoding: 'base64'`, never set here. `slice()`
      // makes the `ArrayBuffer`-backed copy `Blob` can take.
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
    // A blank or oversized HTML part falls through to text. CID expansion has its own post-replacement ceiling.
    ...(inlinedHtml === null ? {} : { html: inlinedHtml.html }),
    inlineImagesTruncated: inlinedHtml?.truncated ?? false,
    attachments,
    senderHeaders: mail.headers
      .filter(header => SENDER_HEADERS.has(header.key))
      .map(({ key, value }) => ({ key, value })),
  };
};

/** Fetch one message body on the account's live connection. */
export const fetchBody = async (
  run: RunTask,
  /** The IMAP mailbox name the uid belongs to, from the folder's sync mark. */
  mailbox: string,
  uid: number,
  expectedRawSize: number | undefined,
): Promise<Result<FetchedBody, MailConnectionFailure>> => {
  if (
    expectedRawSize !== undefined &&
    (!Number.isSafeInteger(expectedRawSize) || expectedRawSize < 0)
  ) {
    return {
      ok: false,
      error: { kind: 'error', detail: 'Message size is unavailable' },
    };
  }
  if (expectedRawSize !== undefined && expectedRawSize > MAX_RAW_MESSAGE_BYTES) {
    return {
      ok: false,
      error: { kind: 'error', detail: 'Message is too large to open safely' },
    };
  }
  return run({
    priority: 'user',
    effect: 'read',
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
