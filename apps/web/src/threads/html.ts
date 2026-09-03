import createDOMPurify from 'dompurify';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types';
import { isPermittedExternalHostname, normalizedUrlInputOf, outboundHrefOf } from './url-policy';

/**
 * A received HTML body, made renderable. Three layers, each assuming the one before failed:
 * DOMPurify's HTML-only profile with hooks narrowing URL shapes; a CSP `<meta>` in the srcdoc
 * denying every fetch (remote images opt in per message); and the iframe sandbox in `HtmlBody.tsx`
 * (no `allow-same-origin`).
 */
export type MailFrame = {
  readonly srcdoc: string;
  /** The message references opt-in remote images. */
  readonly hasRemoteImages: boolean;
  /** The distinct-origin ceiling removed images that consent cannot restore. */
  readonly remoteImagesTruncated: boolean;
};

const PROTOCOL_RELATIVE_URL = /^\/\//;
const REMOTE_IMAGE_URL = /^https:\/\//i;
const SAFE_DATA_IMAGE = new RegExp(
  `^data:(?:${SAFE_INLINE_IMAGE_MIME_TYPES.join('|')});base64,[a-z0-9+/=\\s]+$`,
  'i',
);
// An escape or comment can disguise `url`; image-set also accepts URL-like candidates.
const CSS_RESOURCE_SYNTAX = /url\s*\(|(?:-webkit-)?image-set\s*\(|https?:|\/\/|\\|\/\*/i;
const MAX_REMOTE_IMAGE_ORIGINS = 64;

// Accepts less CSS than a browser: every retained fragment must be a declaration free of
// fetch/obfuscation syntax. The browser CSSOM does the authoritative parse below.
const fetchFreeInlineStyleOf = (raw: string): string =>
  raw
    .split(';')
    .map(declaration => declaration.trim())
    .filter(declaration => declaration.includes(':') && !CSS_RESOURCE_SYNTAX.test(declaration))
    .join(';');

// A blocked image keeps a transparent pixel: an `<img>` with no source is a broken-image icon in WebKit.
const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
/** Marks an image consent can restore. */
const WITHHELD_IMAGE_ATTR = 'data-yozz-withheld';
// A warm mid grey reads on both the dark and the white ground.
const WITHHELD_IMAGE_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238f8a80' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2'/%3E%3Ccircle cx='9' cy='9.5' r='1.5'/%3E%3Cpath d='M21 15l-4.5-4.5L8 19M3 17l3.5-3.5L9 16'/%3E%3C/svg%3E";
// HTML's dimension parser: leading digits, optional `px`; a `%` width says nothing about the ratio.
const PIXEL_DIMENSION = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;
const pixelsOf = (raw: string | null): number | null => {
  const match = raw?.match(PIXEL_DIMENSION);
  return match === null || match === undefined ? null : Number(match[1]);
};

/**
 * Only a picture the sender gave a box to is drawn as withheld; a tracking pixel stays invisible.
 * The transparent pixel is square, so the ratio is restated or `height:auto` draws a square.
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

// YOZZ is dark whatever the OS says, so the dark query becomes an always-true feature and the
// light one never-true; both stay valid inside compound queries, unlike a bare `all` / `not all`.
const darkSchemeMediaOf = (mediaText: string): string =>
  mediaText
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(min-width:0)')
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(max-width:0)');

const COLOUR_DECLARATION = /(?:^|[;{\s])(?:background(?:-color)?|color)\s*:/i;
const COLOUR_ATTRIBUTE_SELECTOR = '[bgcolor], [color], [style*="color"]';

/**
 * Mail is authored against webmail's white ground, and one side of the pair set alone
 * (`color:#1f2430`, no background) is legible only there. The dark frame is for mail that
 * declares nothing or ships its own dark-scheme rules.
 */
const declaresColours = (parsed: Document, stylesheets: readonly string[]): boolean =>
  parsed.body.querySelector(COLOUR_ATTRIBUTE_SELECTOR) !== null ||
  stylesheets.some(sheet => COLOUR_DECLARATION.test(sheet));

// `@import`, `@font-face` and every other at-rule exists to fetch or to do something mail has no use for.
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
 * `<style>` blocks are re-serialised from a constructed stylesheet, which belongs to no document
 * and drops `@import` unfetched (a `<style>` in any document fetches its imports first). The
 * serialisation decodes CSS escapes, so every `<` is re-escaped or a selector could spell
 * `</style>`.
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

/** `sandbox` (no `same-origin`) + this CSP is the pair the design rests on. */
const cspOf = (allowRemoteImages: boolean, remoteImageOrigins: Set<string>, nonce: string) =>
  [
    "default-src 'none'",
    // `data:` carries the message's own inline (`cid:`) images, rewritten at parse time.
    `img-src data:${allowRemoteImages ? ` ${Array.from(remoteImageOrigins).join(' ')}` : ''}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    // These two do not fall back to default-src; each layer must hold alone.
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

// The first click on a withheld image loads it without following its link. This exact source
// is also admitted by the host CSP's SHA-256: a srcdoc inherits the host policy, then applies
// its own nonce policy, so a drift in either fails.
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
  // Where DOMPurify cannot run, sanitize() returns the input. (happy-dom passes this check and
  // still garbles output, so the tests run under jsdom.)
  if (!purifier.isSupported) throw new Error('DOMPurify is not supported in this environment');
  let hasRemoteImages = false;
  let remoteImagesTruncated = false;
  const remoteImageOrigins = new Set<string>();
  purifier.addHook('afterSanitizeAttributes', node => {
    // A sender who ships the marker would turn their own picture into a consent trigger.
    node.removeAttribute(WITHHELD_IMAGE_ATTR);
    // CSS can fetch through more properties and escape spellings than a regex can enumerate, so
    // every declaration the browser parsed as URL-bearing goes.
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
    // A relative href would inherit the app's base URL; `https:settings/delete` and credential-bearing
    // URLs are equally misleading. Mail cannot link into YOZZ's authenticated origins.
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

    // `srcset` candidates would each need policing; mail rarely uses it and `src` is alongside.
    node.removeAttribute('srcset');
    // Only `<img>` carries a fetch; URLs on every other element are stripped rather than widening the CSP.
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
  // DOMPurify returns only the body, so `<style>` blocks (usually in the head) are collected first.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const rawSheets = Array.from(parsed.querySelectorAll('style'), style => style.textContent);
  const dark =
    rawSheets.some(sheet => DARK_SCHEME_QUERY.test(sheet)) || !declaresColours(parsed, rawSheets);
  const stylesheet = rawSheets.map(sheet => fetchFreeStylesheetOf(sheet, dark)).join('');
  const clean = purifier.sanitize(parsed.body.innerHTML, {
    USE_PROFILES: { html: true },
    // The ones DOMPurify would otherwise let through. Template's inertness can be reversed by innocent application code.
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
  // Dark frame only when the mail set no colours or ships dark-scheme rules; never recoloured either way.
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
