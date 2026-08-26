import createDOMPurify from 'dompurify';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types';
import { isPermittedExternalHostname, normalizedUrlInputOf, outboundHrefOf } from './url-policy';

/**
 * A received HTML body, made renderable. This module is one half of the containment; the other
 * half is the iframe in `HtmlBody.tsx` (`sandbox` without `allow-same-origin`, so the document
 * runs in an opaque origin and can reach neither the app's DOM nor its storage).
 *
 * Layers, each assuming the one before it failed:
 *
 * 1. DOMPurify's HTML-only profile strips scripts, active controls, SVG and MathML. Hooks then
 *    narrow links and fetch carriers to the exact URL shapes mail needs.
 * 2. A CSP `<meta>` inside the srcdoc denies every network fetch (`default-src 'none'`); remote
 *    images are opted in per message, by the reader, never by default. Our one measuring script
 *    runs under a fresh random nonce, so markup that somehow survived (1) still cannot execute.
 * 3. The iframe sandbox blocks navigation, forms and same-origin access; links escape only as
 *    user-clicked popups, each already carrying `rel="noopener noreferrer"`.
 */
export type MailFrame = {
  readonly srcdoc: string;
  /** True when the message references opt-in remote images. */
  readonly hasRemoteImages: boolean;
  /** True when the distinct-origin ceiling removed images that consent cannot restore. */
  readonly remoteImagesTruncated: boolean;
};

const PROTOCOL_RELATIVE_URL = /^\/\//;
const REMOTE_IMAGE_URL = /^https:\/\//i;
const SAFE_DATA_IMAGE = new RegExp(
  `^data:(?:${SAFE_INLINE_IMAGE_MIME_TYPES.join('|')});base64,[a-z0-9+/=\\s]+$`,
  'i',
);
// A declaration with an escape or comment is cheap to lose and expensive to prove fetch-free:
// both can disguise `url`, while image-set also accepts URL-like image candidates.
const CSS_RESOURCE_SYNTAX = /url\s*\(|(?:-webkit-)?image-set\s*\(|https?:|\/\/|\\|\/\*/i;
const MAX_REMOTE_IMAGE_ORIGINS = 64;

// This deliberately accepts less CSS than a browser. A top-level split may break a quoted
// semicolon, but every retained fragment must still be a declaration and independently contain no
// fetch/obfuscation syntax. The browser CSSOM then performs the authoritative parse below.
const fetchFreeInlineStyleOf = (raw: string): string =>
  raw
    .split(';')
    .map(declaration => declaration.trim())
    .filter(declaration => declaration.includes(':') && !CSS_RESOURCE_SYNTAX.test(declaration))
    .join(';');

// A blocked image keeps a transparent pixel instead of losing `src`: an `<img>` with no source is a
// broken-image icon in WebKit, and a picture that is merely withheld should not look broken.
const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
/** Marks an image consent can restore; the frame styles it as withheld and makes it a click target. */
const WITHHELD_IMAGE_ATTR = 'data-yozz-withheld';
// The glyph is a warm mid grey so one rule reads on both the dark and the white ground.
const WITHHELD_IMAGE_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238f8a80' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2'/%3E%3Ccircle cx='9' cy='9.5' r='1.5'/%3E%3Cpath d='M21 15l-4.5-4.5L8 19M3 17l3.5-3.5L9 16'/%3E%3C/svg%3E";
// HTML's dimension parser: leading digits, an optional `px`; a `%` width still reserves a box
// but says nothing about the ratio.
const PIXEL_DIMENSION = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;
const pixelsOf = (raw: string | null): number | null => {
  const match = raw?.match(PIXEL_DIMENSION);
  return match === null || match === undefined ? null : Number(match[1]);
};

/**
 * Only a picture the sender gave a box to is drawn as withheld; a tracking pixel (1x1, or no
 * dimensions at all) stays as invisible as it was. The transparent pixel is square, so the reserved
 * ratio is restated or `height:auto` would draw every withheld picture as a square.
 */
// ponytail: an image sized only by CSS (`style="width:600px"`) still draws square; read the inline width if it matters.
const markWithheld = (node: Element): void => {
  const widthAttr = node.getAttribute('width');
  const leading = Number(widthAttr?.match(/^\s*(\d+)/)?.[1]);
  if (!(leading > 1)) return;
  node.setAttribute(WITHHELD_IMAGE_ATTR, '');
  node.setAttribute('title', 'Load remote images');
  const width = pixelsOf(widthAttr);
  const height = pixelsOf(node.getAttribute('height'));
  if (width === null || height === null || !(height > 1)) return;
  const style = [node.getAttribute('style'), `aspect-ratio:${width}/${height}`]
    .filter(declaration => declaration !== null && declaration !== '')
    .join(';');
  node.setAttribute('style', style);
};
const WITHHELD_IMAGE_STYLE = `img[${WITHHELD_IMAGE_ATTR}]{box-sizing:border-box;border:1px dashed color-mix(in oklch,currentColor 30%,transparent);background:color-mix(in oklch,currentColor 5%,transparent) url("${WITHHELD_IMAGE_ICON}") center/20px no-repeat;cursor:pointer}`;

const fetchFreeDeclarationsOf = (style: CSSStyleDeclaration): string => {
  for (const property of Array.from(style)) {
    if (CSS_RESOURCE_SYNTAX.test(style.getPropertyValue(property))) style.removeProperty(property);
  }
  return style.cssText;
};

const DARK_SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;

// Inside the frame `prefers-color-scheme` would follow the OS, but YOZZ is dark whatever the OS
// says, so a mail's own dark-scheme rules are resolved at serialisation: the dark query becomes a
// feature that always matches, the light one a feature that never does. Both stay valid inside
// compound queries (`screen and (...)`), which a bare `all` / `not all` would not.
const darkSchemeMediaOf = (mediaText: string): string =>
  mediaText
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(min-width:0)')
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(max-width:0)');

const COLOUR_DECLARATION = /(?:^|[;{\s])(?:background(?:-color)?|color)\s*:/i;
const COLOUR_ATTRIBUTE_SELECTOR = '[bgcolor], [color], [style*="color"]';

/**
 * Whether the sender set ANY colour: a foreground, a background, or a `<font color>`. Mail is
 * authored against webmail's white ground, and a message that sets only one side of the pair
 * (`color:#1f2430` and no background is the common case) is legible only on that ground. The dark
 * frame is therefore reserved for mail that declares nothing, which then inherits the reader's
 * paper on ink, and for mail that carries its own dark-scheme rules and so was built for both.
 */
const declaresColours = (parsed: Document, stylesheets: readonly string[]): boolean =>
  parsed.body.querySelector(COLOUR_ATTRIBUTE_SELECTOR) !== null ||
  stylesheets.some(sheet => COLOUR_DECLARATION.test(sheet));

// Only plain rules and `@media` groups survive: `@import`, `@font-face` and every other at-rule
// exists to fetch or to do something mail has no use for.
const fetchFreeRulesOf = (rules: CSSRuleList, dark: boolean): string =>
  Array.from(rules)
    .map(rule => {
      if (rule instanceof CSSMediaRule) {
        const media = dark ? darkSchemeMediaOf(rule.media.mediaText) : rule.media.mediaText;
        return `@media ${media}{${fetchFreeRulesOf(rule.cssRules, dark)}}`;
      }
      if (!(rule instanceof CSSStyleRule)) return '';
      const declarations = fetchFreeDeclarationsOf(rule.style);
      return declarations === '' ? '' : `${rule.selectorText}{${declarations}}`;
    })
    .join('');

/**
 * Templated mail keeps its layout (`max-width`, centring, media queries) in `<style>` blocks, so
 * they are kept, re-serialised from the browser's own parse with every URL-bearing declaration
 * removed. The parse is a constructed stylesheet: it belongs to no document, applies nowhere, and
 * the spec has it drop `@import` unfetched (a `<style>` in any document, even under
 * `media="not all"`, fetches its imports before the CSSOM can be read).
 *
 * The serialisation decodes CSS escapes, so a selector string can come back holding `</style>`
 * and end the frame's raw-text element from inside; every `<` is re-escaped as CSS so the sheet
 * cannot spell a tag.
 */
const fetchFreeStylesheetOf = (css: string, dark: boolean): string => {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  return fetchFreeRulesOf(sheet.cssRules, dark).replace(/</g, '\\3c ');
};

/** Only encrypted absolute image URLs are loadable after consent; credentials are never retained. */
const remoteImageUrlOf = (
  value: string,
): { readonly href: string; readonly origin: string } | null => {
  const trimmed = normalizedUrlInputOf(value);
  if (trimmed === null) return null;
  const candidate = PROTOCOL_RELATIVE_URL.test(trimmed) ? `https:${trimmed}` : trimmed;
  if (!REMOTE_IMAGE_URL.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.username !== '' || url.password !== '' || !isPermittedExternalHostname(url.hostname))
      return null;
    return { href: url.href, origin: url.origin };
  } catch {
    return null;
  }
};

/** `sandbox` (no `same-origin`) + this CSP is the pair the whole design rests on. */
const cspOf = (allowRemoteImages: boolean, remoteImageOrigins: Set<string>, nonce: string) =>
  [
    "default-src 'none'",
    // `data:` carries the message's own inline (`cid:`) images, rewritten at parse time; they are
    // part of the message, so they show without any network and without asking.
    `img-src data:${allowRemoteImages ? ` ${Array.from(remoteImageOrigins).join(' ')}` : ''}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    // These two do NOT fall back to default-src. Both are also covered by the sanitizer
    // (FORBID_TAGS) and the sandbox (no allow-forms) — but each layer must hold alone.
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

// A withheld image is often wrapped in a link; the first click loads the picture and does not
// follow it (once loaded, the attribute is gone and the link works as sent).
// This exact source is also admitted by the host CSP's SHA-256. A srcdoc document inherits the
// host policy, then applies its own nonce policy as a second constraint; the browser gate executes
// this under both and fails if either the script or the hash drifts.
const MAIL_FRAME_MEASURE_SCRIPT = `let pending=0,last=-1;
const post=()=>{pending=0;const height=document.documentElement.scrollHeight;if(height===last)return;last=height;parent.postMessage({type:'yozz:mail-height',height},'*')};
const schedule=()=>{if(pending===0)pending=setTimeout(post,100)};
new ResizeObserver(schedule).observe(document.body);
addEventListener('load',schedule);
addEventListener('click',e=>{if(!(e.target instanceof HTMLImageElement&&e.target.hasAttribute('${WITHHELD_IMAGE_ATTR}')))return;e.preventDefault();parent.postMessage({type:'yozz:load-remote-images'},'*')});`;

const randomNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export const buildMailFrame = (
  html: string,
  { allowRemoteImages }: { allowRemoteImages: boolean },
): MailFrame => {
  const purifier = createDOMPurify(window);
  // In an environment DOMPurify cannot support, sanitize() returns the INPUT — a silent no-op is
  // the one failure mode this must never have. (happy-dom passes this check and still garbles the
  // output, which is why the tests run under jsdom.)
  if (!purifier.isSupported) throw new Error('DOMPurify is not supported in this environment');
  let hasRemoteImages = false;
  let remoteImagesTruncated = false;
  const remoteImageOrigins = new Set<string>();
  purifier.addHook('afterSanitizeAttributes', node => {
    // The marker is ours alone: a sender who ships it would turn their own inline picture into a
    // consent trigger. Only `markWithheld` below may set it.
    node.removeAttribute(WITHHELD_IMAGE_ATTR);
    // CSS can fetch through more properties and escape spellings than a small URL regex can
    // safely enumerate. Preserve inline layout, but remove every declaration the browser parsed
    // as a URL-bearing value. `<style>` blocks get the same treatment in `fetchFreeStylesheetOf`.
    if (node instanceof HTMLElement) {
      const rawStyle = node.getAttribute('style');
      if (rawStyle !== null) {
        const fetchFreeStyle = fetchFreeInlineStyleOf(rawStyle);
        if (fetchFreeStyle === '') node.removeAttribute('style');
        else node.setAttribute('style', fetchFreeStyle);
      }
      for (const property of Array.from(node.style)) {
        if (CSS_RESOURCE_SYNTAX.test(node.style.getPropertyValue(property)))
          node.style.removeProperty(property);
      }
    }
    // A relative href would inherit the app's base URL. Slashless `https:settings/delete` and
    // credential-bearing URLs are equally misleading, so links survive only after URL parsing and
    // canonicalisation. Mail cannot link into YOZZ's authenticated origins; that boundary remains
    // non-navigable even when a server endpoint later regresses on CSRF protection.
    if (node.tagName === 'A' || node.tagName === 'AREA') {
      const href = node.getAttribute('href');
      const outbound = href === null ? null : outboundHrefOf(href);
      if (outbound !== null) {
        node.setAttribute('href', outbound);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        node.setAttribute('referrerpolicy', 'no-referrer');
      } else {
        node.removeAttribute('href');
        node.removeAttribute('target');
        node.removeAttribute('rel');
        node.removeAttribute('referrerpolicy');
        node.removeAttribute('style');
        node.setAttribute('aria-disabled', 'true');
        node.setAttribute('title', 'Link unavailable in YOZZ');
      }
      return;
    }

    // `srcset` is a composite value whose candidates would each need parsing to police; mail
    // rarely uses it and `src` is present alongside, so it is dropped outright.
    node.removeAttribute('srcset');
    // HTML mail needs only `<img>` as a fetch carrier. DOMPurify's HTML profile removes SVG and
    // MathML entirely; URLs on every other element are stripped instead of widening the CSP.
    for (const attr of ['src', 'poster', 'background', 'href']) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      if (node.tagName === 'IMG' && attr === 'src' && SAFE_DATA_IMAGE.test(value.trim())) continue;
      const remote = node.tagName === 'IMG' && attr === 'src' ? remoteImageUrlOf(value) : null;
      if (remote !== null) {
        if (
          !remoteImageOrigins.has(remote.origin) &&
          remoteImageOrigins.size >= MAX_REMOTE_IMAGE_ORIGINS
        ) {
          remoteImagesTruncated = true;
          node.setAttribute(attr, BLOCKED_IMAGE_PLACEHOLDER);
          continue;
        }
        remoteImageOrigins.add(remote.origin);
        hasRemoteImages = true;
        if (allowRemoteImages) {
          node.setAttribute(attr, remote.href);
          node.setAttribute('referrerpolicy', 'no-referrer');
        } else {
          node.setAttribute(attr, BLOCKED_IMAGE_PLACEHOLDER);
          markWithheld(node);
        }
        continue;
      }
      node.removeAttribute(attr);
    }
  });
  // DOMPurify returns only the body, so `<style>` blocks (usually in the head) are collected from
  // the parsed document first; the sanitizer then forbids the tag, and the sheets re-enter below.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const rawSheets = Array.from(parsed.querySelectorAll('style'), style => style.textContent);
  const dark =
    rawSheets.some(sheet => DARK_SCHEME_QUERY.test(sheet)) || !declaresColours(parsed, rawSheets);
  const stylesheet = rawSheets.map(sheet => fetchFreeStylesheetOf(sheet, dark)).join('');
  const clean = purifier.sanitize(parsed.body.innerHTML, {
    USE_PROFILES: { html: true },
    // Forms and metadata tags have no business in mail; most are refused by default, these are
    // the ones DOMPurify would otherwise let through. Template is explicit because its inertness
    // can be reversed later by otherwise-innocent application code.
    FORBID_TAGS: [
      'form',
      'input',
      'textarea',
      'select',
      'button',
      'meta',
      'base',
      'link',
      'template',
      'audio',
      'video',
      'source',
      'picture',
      'track',
      'style',
    ],
  });

  const nonce = randomNonce();
  // Dark frame (transparent body, `--paper` text repeated here because the frame cannot see the
  // app's vars) only when `declaresColours` says the mail set none, or it ships dark-scheme rules;
  // otherwise the white ground the sender authored against. Never recoloured either way.
  const ground = dark
    ? ':root{color-scheme:dark}body{background:transparent;color:oklch(0.945 0.008 85)}'
    : ':root{color-scheme:light}body{background:#fff;color:#111}';
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${cspOf(allowRemoteImages, remoteImageOrigins, nonce)}">
<style>
${ground}
body{margin:12px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:break-word}
img{max-width:100%;height:auto}
${WITHHELD_IMAGE_STYLE}
</style>
<style>${stylesheet}</style>
</head><body>${clean}
<script nonce="${nonce}">${MAIL_FRAME_MEASURE_SCRIPT}</script>
</body></html>`;
  return { srcdoc, hasRemoteImages, remoteImagesTruncated };
};
