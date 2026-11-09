import { DEFAULT_MAX_LITERAL_BYTES } from '@yozz.app/imap';
import { type DefaultTreeAdapterTypes, html, parse } from 'parse5';
import PostalMime from 'postal-mime';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import { attachmentKindOf } from './attachments.ts';
import { MAX_CACHED_BODY_BYTES } from './body-state.ts';
import { type TxtLookup, verifySender } from './dkim.ts';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types.ts';
import type { Location } from './thread.ts';
import { type Attachment, renumberedText, toParagraphs } from './thread.ts';
import { type Unsubscribe, unsubscribeOf } from './unsubscribe.ts';

export type FetchedBody = {
  readonly paragraphs: string[];
  /** `paragraphs` is the sender's `text/plain` part, not a reduction of the HTML. */
  readonly hasTextPart: boolean;
  /** The sender's text part is shown but the HTML part has words it lacks (`htmlHasWordsTextLacks`). */
  readonly htmlSaysMore: boolean;
  /** `cid:` images inlined as `data:` URIs. Sanitized at render, not here. */
  readonly html?: string;
  /** A CID allocation ceiling left one or more inline images unavailable. */
  readonly inlineImagesTruncated: boolean;
  readonly attachments: Attachment[];
  /**
   * What the message's `List-Unsubscribe` offers, or null when it offers nothing we act on. Always
   * present, so a body cached before it was kept is refetched rather than read as "no offer".
   */
  readonly unsubscribe: Unsubscribe | null;
  /**
   * The From address a DKIM signature vouches for and the domain that signed it, or null. A property
   * of the message, not of the mailbox that received the copy; `senderCheckOf` compares `from` with
   * the address the reader shows. Always a settled answer: a body that is still being checked is an
   * `OpenedBody`, and only becomes a `FetchedBody` (the one the cache keeps) once the check is in.
   */
  readonly dkim: { readonly from: string; readonly domain: string } | null;
};

/** What a sender check came to. */
export type SenderOutcome = {
  readonly dkim: FetchedBody['dkim'];
  /**
   * False when a key lookup got no answer (`lookup-failed`): the sender may well be signed, so the
   * body shows as not verified for now and is never kept, and the next open checks it again.
   */
  readonly isFinal: boolean;
};

/** A body readable at once, with its sender check still on its way. `check` never rejects. */
export type OpenedBody = {
  readonly body: Omit<FetchedBody, 'dkim'>;
  readonly check: Promise<SenderOutcome>;
};

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

const textOf = (node: ChildNode, shouldShowLinks: boolean, depth = 0): string => {
  if (isText(node)) return node.value.replace(/\s+/g, ' ');
  if (!isElement(node) || isDropped(node)) return '';
  const tagName = tagNameOf(node);
  if (tagName === 'BR') return '\n';
  // Past this depth, a flat walk handles pathological nesting without growing the call stack.
  const inner =
    depth >= MAX_HTML_TEXT_DEPTH
      ? flatTextOf(node).replace(/\s+/g, ' ')
      : node.childNodes.map(child => textOf(child, shouldShowLinks, depth + 1)).join('');
  // Without the destination "click here" says nothing.
  if (tagName === 'A' && shouldShowLinks) {
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
export const htmlToText = (
  markup: string,
  { shouldShowLinks = true }: { readonly shouldShowLinks?: boolean } = {},
): string => {
  const root = parse(markup, { scriptingEnabled: false }).childNodes.find(isElement);
  // `Document.body`: the root's first `<body>` or `<frameset>`, whose `<noframes>` is the fallback.
  const body = root?.childNodes.find(
    (node): node is Element =>
      isElement(node) && (node.tagName === 'body' || node.tagName === 'frameset'),
  );
  return body === undefined ? '' : textOf(body, shouldShowLinks);
};

/** A URL as far as its ASCII characters go: it stops at CJK, a dash or a closing bracket, so the words after it stay. */
const URL_PATTERN = /\b(?:(?:https?|ftp|mailto|tel):|www\.)[\w\-.~:/?#@!$&'*+,;=%]*/giu;
/** Marks join a word: without `\p{M}` Devanagari and Thai words fall apart. */
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;

/** The distinct lowercase words of `text`, with URLs left out: layout, punctuation and order are not words. */
const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(text.normalize('NFKC').replace(URL_PATTERN, ' ').toLowerCase().match(WORD_PATTERN));

/**
 * Whether the HTML part, reduced to text, holds a word the text part does not. A sender's text
 * part is shown whenever there is one, so this is the only sign the HTML says something it
 * leaves out. Compared as sets of words: re-wrapping, punctuation, link rendering and ordering
 * differ between the two parts of a faithful message, a sentence missing from one does not. An
 * HTML-only footer counts: the reader cannot see it otherwise, and a flag costs one `--full`.
 */
export const htmlHasWordsTextLacks = (text: string, html: string): boolean => {
  const known = wordsOf(text);
  // Without the destinations `htmlToText` writes beside a link, which the sender's text may omit.
  return wordsOf(htmlToText(html, { shouldShowLinks: false })).difference(known).size > 0;
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

/** The message's own content: everything `FetchedBody` holds but the check of who sent it. */
const contentOf = async (raw: Uint8Array): Promise<Omit<FetchedBody, 'dkim'>> => {
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
    htmlSaysMore:
      senderText !== null &&
      inlinedHtml !== null &&
      mail.html !== undefined &&
      htmlHasWordsTextLacks(senderText, mail.html),
    // A blank or oversized HTML part falls through to text. CID expansion has its own post-replacement ceiling.
    ...(inlinedHtml === null ? {} : { html: inlinedHtml.html }),
    inlineImagesTruncated: inlinedHtml?.truncated ?? false,
    attachments,
    // The first header wins: RFC 2369 allows one, and a duplicate is the sender's mistake.
    unsubscribe: unsubscribeOf(mail.headers.find(({ key }) => key === 'list-unsubscribe')?.value),
  };
};

/**
 * The body as soon as it is parsed, and the sender check beside it, started first so the two
 * overlap. A caller that shows the body must show the check as pending until `dkim` settles.
 */
export const openBody = async (raw: Uint8Array, lookupTxt: TxtLookup): Promise<OpenedBody> => {
  if (raw.byteLength > MAX_RAW_MESSAGE_BYTES) {
    throw new Error('Message is too large to open safely');
  }
  // `verifySender` is total, so this promise never rejects, even when the parse below throws.
  const check = verifySender(raw, lookupTxt).then(
    (verdict): SenderOutcome => ({
      dkim: verdict.status === 'verified' ? { from: verdict.from, domain: verdict.domain } : null,
      isFinal: !(verdict.status === 'unverified' && verdict.reason === 'lookup-failed'),
    }),
  );
  return { body: await contentOf(raw), check };
};

/**
 * The whole body, check included: for a caller that reads once and cannot show a check pending.
 * `isFinal` says whether the body may be kept.
 */
export const parseBody = async (
  raw: Uint8Array,
  lookupTxt: TxtLookup,
): Promise<{ readonly body: FetchedBody; readonly isFinal: boolean }> => {
  const { body, check } = await openBody(raw, lookupTxt);
  const { dkim, isFinal } = await check;
  return { body: { ...body, dkim }, isFinal };
};

/** Fetch one message on the mailbox's live connection and open it: the body now, its check to follow. */
export const fetchOpenBody = async (
  run: RunTask,
  /** The IMAP folder name the uid belongs to, from the folder's sync mark. */
  folderName: string,
  uid: number,
  expectedRawSize: number | undefined,
  lookupTxt: TxtLookup,
): Promise<Result<OpenedBody, MailConnectionFailure>> => {
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
  const raw = await run({
    priority: 'user',
    effect: 'read',
    retry: true,
    run: async client => {
      const selectRes = await client.ensureSelected(folderName);
      if (!selectRes.ok) return { ok: false, error: { kind: 'imap', reason: selectRes.reason } };
      const rawRes = await client.fetchRaw(uid);
      if (!rawRes.ok) return { ok: false, error: { kind: 'imap', reason: rawRes.reason } };
      return rawRes;
    },
  });
  if (!raw.ok) return raw;
  // After the task: the connection is not held while DNS answers.
  try {
    return { ok: true, value: await openBody(raw.value, lookupTxt) };
  } catch (error) {
    return {
      ok: false,
      error: { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
    };
  }
};

/** The folder name a copy's uid belongs to, unless its folder never synced or was renumbered: a stale uid may now name other mail. */
const folderNameOf = async (
  folderCache: {
    readonly getSync: () => Promise<{ readonly name: string; readonly uidValidity: number } | null>;
  },
  copy: Omit<Location, 'mailbox'>,
): Promise<Result<string, MailConnectionFailure>> => {
  const mark = await folderCache.getSync();
  if (mark === null) {
    return { ok: false, error: { kind: 'error', detail: `${copy.folder} has not synced` } };
  }
  if (mark.uidValidity !== copy.uidValidity) {
    return { ok: false, error: { kind: 'error', detail: renumberedText(copy.folder) } };
  }
  return { ok: true, value: mark.name };
};

/** The cache this was fetched for: what it is told of the copy's folder, and where a body is kept. */
type BodyFolderCache = {
  readonly getSync: () => Promise<{ readonly name: string; readonly uidValidity: number } | null>;
  readonly putBody: (uid: number, body: FetchedBody) => Promise<void>;
};

const isCacheable = (expectedRawSize: number | undefined) =>
  (expectedRawSize ?? Number.POSITIVE_INFINITY) <= MAX_CACHED_BODY_BYTES;

/**
 * Fetches the body of one copy, off its folder's sync mark, waits for its sender check and caches
 * it when the message is small enough and the check is final. A copy read under another
 * `UIDVALIDITY` is refused: its uid may now name other mail.
 */
export const fetchBodyAt = async (
  run: RunTask,
  folderCache: BodyFolderCache,
  copy: Omit<Location, 'mailbox'>,
  expectedRawSize: number | undefined,
  lookupTxt: TxtLookup,
  /** The cache this was fetched for has been cleared since (a lock, an address removed): keep nothing. */
  isStale: () => boolean = () => false,
): Promise<Result<FetchedBody, MailConnectionFailure>> => {
  const folderName = await folderNameOf(folderCache, copy);
  if (!folderName.ok) return folderName;
  const opened = await fetchOpenBody(run, folderName.value, copy.uid, expectedRawSize, lookupTxt);
  if (!opened.ok) return opened;
  const { dkim, isFinal } = await opened.value.check;
  const body = { ...opened.value.body, dkim };
  if (isFinal && !isStale() && isCacheable(expectedRawSize)) {
    // Best effort: a body that did not cache is fetched again next time.
    await folderCache.putBody(copy.uid, body).catch(() => {});
  }
  return { ok: true, value: body };
};

/**
 * `fetchBodyAt` for a reader that shows the body at once. The cache keeps a body with its check
 * settled and final, never half of one, so it is written when `check` lands; a tab closed before
 * then, or a lookup that got no answer, leaves nothing, and the next open fetches the message again.
 */
export const fetchOpenBodyAt = async (
  run: RunTask,
  folderCache: BodyFolderCache,
  copy: Omit<Location, 'mailbox'>,
  expectedRawSize: number | undefined,
  lookupTxt: TxtLookup,
  isStale: () => boolean = () => false,
): Promise<Result<OpenedBody, MailConnectionFailure>> => {
  const folderName = await folderNameOf(folderCache, copy);
  if (!folderName.ok) return folderName;
  const res = await fetchOpenBody(run, folderName.value, copy.uid, expectedRawSize, lookupTxt);
  if (res.ok && isCacheable(expectedRawSize)) {
    const { body, check } = res.value;
    void (async () => {
      const { dkim, isFinal } = await check;
      // Best effort, and judged when the check lands: the cache may have been cleared meanwhile.
      if (isFinal && !isStale()) {
        await folderCache.putBody(copy.uid, { ...body, dkim }).catch(() => {});
      }
    })();
  }
  return res;
};
