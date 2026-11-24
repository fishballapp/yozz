import { mimeTypeOf } from './attachments.ts';
import { withoutDirectionOverrides } from './direction-controls.ts';
import { SAFE_INLINE_IMAGE_MIME_TYPES } from './image-types.ts';
import type { Attachment } from './thread.ts';

/**
 * What a received attachment is, read from its bytes and its name, for every client to state the
 * same way: the name it is shown and saved under (`savedName`), the type the bytes identify
 * (`detectedTypeOf`), what may preview (`previewOf`), and the notes on a file whose bytes or name are
 * not what they claim (`attachmentFactsOf`), each worded once here by `noteText`. Pure functions over
 * bytes and strings: no DOM, no Node, nothing sent anywhere. Every pass is linear in its input, since
 * the name and the bytes are the sender's.
 */

type SafeImageType = 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

/** A program: what runs when opened, as its platform's loader reads it. */
type ProgramType =
  | 'application/vnd.microsoft.portable-executable'
  | 'application/x-executable'
  | 'application/x-mach-binary'
  | 'application/x-ms-shortcut';

/** A document a browser renders, script and all. */
type PageType = 'text/html' | 'image/svg+xml';

export type DetectedType = SafeImageType | 'application/pdf' | ProgramType | PageType;

/**
 * Controls (C0, DEL, C1) and the bidirectional marks (ALM, LRM, RLM): what a name can hide behind
 * once `withoutDirectionOverrides` has taken out what reorders it. The marks are kept in a sender's
 * name or a subject for right-to-left text; a file name loses them too, since an extension is read
 * as it is saved.
 */
const HIDING = /[\p{Cc}\u061c\u200e\u200f]/gu;

/**
 * Room for any real name, and for the ` (1000)` a taken one may gain, short of every file system's
 * 255-byte limit.
 */
const MAX_NAME_BYTES = 192;

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The longest start of `text` within `max` UTF-8 bytes, cut between code points. */
const withinBytes = (text: string, max: number) => {
  const kept: string[] = [];
  let used = 0;
  for (const point of text) {
    used += bytesOf(point);
    if (used > max) break;
    kept.push(point);
  }
  return kept.join('');
};

const isDotOrSpace = (character: string) => character === '.' || /\s/u.test(character);

/**
 * `text` without leading and trailing dots and whitespace, trimmed by hand: `[.\s]+$` retries from
 * every start in a long run of dots that does not end the string, quadratic in a name the sender
 * chose (as `dkim.ts` trims for the same reason).
 */
const trimDotsAndSpaces = (text: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && isDotOrSpace(text.charAt(start))) start += 1;
  while (end > start && isDotOrSpace(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
};

/**
 * The name an attachment is shown under, saved under and judged under, the same in every client: its
 * last path segment, without controls or bidirectional overrides (a line break or tab becomes a
 * space), separators, `:`, leading dots (so no `..` and nothing hidden) or trailing dots and spaces
 * (which Windows drops on save), within `MAX_NAME_BYTES` with its extension kept. The notes read
 * this name and no other, so what a note says is about the file a person or a script ends up with.
 */
export const savedName = (name: string): string => {
  const segment =
    withoutDirectionOverrides(name.normalize('NFC'))
      .replace(HIDING, character => (character === '\n' || character === '\t' ? ' ' : ''))
      .split(/[/\\]/u)
      .at(-1) ?? '';
  const bare = trimDotsAndSpaces(segment.replaceAll(':', '_'));
  if (bare === '') return 'attachment';
  if (bytesOf(bare) <= MAX_NAME_BYTES) return bare;
  const dot = bare.lastIndexOf('.');
  const extension = dot > 0 && bare.length - dot <= 16 ? bare.slice(dot) : '';
  const stem = withinBytes(
    bare.slice(0, bare.length - extension.length),
    MAX_NAME_BYTES - bytesOf(extension),
  );
  return `${trimDotsAndSpaces(stem) || 'attachment'}${extension}`;
};

const ascii = (text: string) => Array.from(text, character => character.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

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
  const boxEnd = viewOf(bytes).getUint32(0);
  if (boxEnd < 16 || boxEnd > MAX_FTYP_BOX_BYTES || boxEnd > bytes.length) return false;
  // Offset 8 is the major brand and 12 the minor version, which is not a brand; the compatible
  // brands follow from 16.
  for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
    if (offset !== 12 && AVIF_BRANDS.some(brand => startsWith(bytes, brand, offset))) return true;
  }
  return false;
};

/**
 * `MZ`, then at the offset the DOS header's `e_lfanew` holds, `PE\0\0`: what Windows loads. `MZ`
 * alone is any file whose text starts with those two letters.
 */
const isPortableExecutable = (bytes: Uint8Array) => {
  if (bytes.length < 0x40 || !startsWith(bytes, ascii('MZ'))) return false;
  return startsWith(bytes, [0x50, 0x45, 0, 0], viewOf(bytes).getUint32(0x3c, true));
};

const MACH_O_MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
];

/**
 * A universal binary starts `CAFEBABE` as a Java class file does. Its next word counts the
 * architectures inside, a handful; a class file's is its version, 45 or more (as `file(1)` tells
 * them apart).
 */
const isUniversalBinary = (bytes: Uint8Array) => {
  if (bytes.length < 8 || !startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return false;
  const architectures = viewOf(bytes).getUint32(4);
  return architectures > 0 && architectures < 20;
};

/** A shell link's header size, `0x4C`, then its class id, 00021401-0000-0000-C000-000000000046. */
const SHELL_LINK_HEADER = [
  0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46,
];

/** How far into a file markup is looked for. A page announces itself in its first lines. */
const MARKUP_PREFIX_BYTES = 1024;

/** The start of the file as text, its byte order mark and leading whitespace gone. */
const markupPrefix = (bytes: Uint8Array) =>
  new TextDecoder('utf-8')
    .decode(bytes.subarray(0, MARKUP_PREFIX_BYTES))
    .replace(/^\ufeff/u, '')
    .trimStart();

/**
 * The tags the WHATWG MIME sniffing standard reads as HTML at the start of a file (§7.1, "identifying
 * a resource with an unknown MIME type"), each ending in a space or `>`, or a comment opening.
 */
const HTML_START =
  /^(?:<!doctype html|<html|<head|<script|<iframe|<h1|<div|<font|<table|<a|<style|<title|<b|<body|<br|<p)[\s>]|^<!--[\s>]/iu;

const startsWithAnyCase = (text: string, prefix: string, at: number) =>
  text.slice(at, at + prefix.length).toLowerCase() === prefix;

/** Just past the first `closing` at or after `at`, or -1 when the prefix ends first. */
const pastNext = (text: string, closing: string, at: number) => {
  const found = text.indexOf(closing, at);
  return found === -1 ? -1 : found + closing.length;
};

/** Just past a doctype starting at `at`, its internal subset (`[…]`) included, or -1. */
const pastDoctype = (text: string, at: number) => {
  for (let index = at; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '>') return index + 1;
    if (character === '[') {
      const subsetEnd = text.indexOf(']', index);
      return subsetEnd === -1 ? -1 : pastNext(text, '>', subsetEnd);
    }
  }
  return -1;
};

/**
 * An XML prolog, comments and doctypes, in any order, then the `<svg` root. A scanner, not a
 * pattern: every step only moves forward, so it is linear in the prefix, where a pattern repeating a
 * lazy comment group backtracked exponentially on `<!---->` after `<!---->`.
 */
const isSvgStart = (text: string) => {
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/u.test(text.charAt(at))) at += 1;
    const next = (() => {
      if (startsWithAnyCase(text, '<?xml', at)) return pastNext(text, '>', at);
      if (text.startsWith('<!--', at)) return pastNext(text, '-->', at + 4);
      if (startsWithAnyCase(text, '<!doctype', at)) return pastDoctype(text, at);
      return null;
    })();
    if (next === null) return /^<svg[\s>/]/iu.test(text.slice(at, at + 5));
    if (next === -1) return false;
    at = next;
  }
};

/**
 * Magic numbers, most specific first. SVG before HTML, since a drawing may open with the comment
 * HTML also may.
 */
const SIGNATURES: readonly (readonly [DetectedType, (bytes: Uint8Array) => boolean])[] = [
  ['image/png', bytes => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', bytes => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ['image/gif', bytes => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))],
  ['image/webp', bytes => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)],
  ['image/avif', isAvif],
  ['application/pdf', bytes => startsWith(bytes, ascii('%PDF-'))],
  ['application/vnd.microsoft.portable-executable', isPortableExecutable],
  ['application/x-executable', bytes => startsWith(bytes, [0x7f, ...ascii('ELF')])],
  [
    'application/x-mach-binary',
    bytes => MACH_O_MAGICS.some(magic => startsWith(bytes, magic)) || isUniversalBinary(bytes),
  ],
  ['application/x-ms-shortcut', bytes => startsWith(bytes, SHELL_LINK_HEADER)],
  ['image/svg+xml', bytes => isSvgStart(markupPrefix(bytes))],
  ['text/html', bytes => HTML_START.test(markupPrefix(bytes))],
];

/** The type the bytes identify, or null for one this does not know. Never the sender's word. */
export const detectedTypeOf = (bytes: Uint8Array): DetectedType | null =>
  SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null;

/**
 * A saved name as it is drawn: without default-ignorable code points (zero-width spaces and joiners,
 * soft hyphens, variation selectors, the combining grapheme joiner) and combining marks, which draw
 * as nothing or over the letter before them. `invoice.pdf<U+200B>.js` looks like `invoice.pdf.js`,
 * so it is judged as one. Only the notes read it; the saved name keeps them, since a zero-width
 * non-joiner is spelling in a Persian name and a joiner is part of an emoji.
 */
const drawnName = (saved: string) => saved.replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, '');

/**
 * A drawn name's extension, or null when its last part is not a plain one. Each start tries a dot
 * and at most twelve characters, so this stays linear on any name.
 */
const extensionOf = (saved: string): string | null =>
  /\.([a-z0-9]{1,12})$/iu.exec(saved)?.[1]?.toLowerCase() ?? null;

/** A drawn name without its extension, as the file system would keep that stem. */
const stemOf = (saved: string) => trimDotsAndSpaces(saved.replace(/\.[a-z0-9]{1,12}$/iu, ''));

// Previews

export type Preview =
  | { readonly kind: 'image'; readonly mimeType: SafeImageType }
  | { readonly kind: 'text' }
  | { readonly kind: 'pdf' };

/**
 * Text above this does not preview: one `<pre>` of a 30 MB log takes seconds to lay out, and a
 * file that size is a download anyway. Images and PDFs have no cap of their own; the 64 MiB message
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

const SAFE_IMAGE_TYPES: ReadonlySet<DetectedType> = new Set<SafeImageType>([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const isSafeImage = (type: DetectedType): type is SafeImageType => SAFE_IMAGE_TYPES.has(type);

const isUtf16 = (bytes: Uint8Array) =>
  startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);

/** Git's heuristic: a NUL in the first 8000 bytes is a binary file wearing a text label. */
const looksLikeText = (bytes: Uint8Array) => isUtf16(bytes) || !bytes.subarray(0, 8000).includes(0);

/** The kind the sender's label claims, or under a generic label the one the extension does. */
const claimedKind = (name: string, mimeType: string | undefined) => {
  const label = mimeType?.toLowerCase() ?? '';
  if (!GENERIC_LABELS.has(label)) return KIND_BY_LABEL.get(label);
  const extension = extensionOf(drawnName(savedName(name)));
  return extension === null ? undefined : KIND_BY_EXTENSION.get(extension);
};

/**
 * What a client may open in place, or `null` for a download only. It previews only when the
 * sender's label (or, under a generic label, the file's extension) AND the bytes agree on a kind
 * that cannot become a document with script (DECISIONS.md, 2026-10-15): a raster image, plain text
 * or a PDF. HTML, SVG and the rest only download. A PDF with notes does not preview either: it opens
 * in a tab, outside the app, which an engine with no PDF viewer saves past the question the notes
 * ask. An image or text with notes still shows, in the app, where nothing runs.
 */
export const previewOf = ({ name, mimeType, content }: Attachment): Preview | null => {
  if (content === undefined) return null;
  const detected = detectedTypeOf(content);
  switch (claimedKind(name, mimeType)) {
    case 'image': {
      // The bytes name the type, so a PNG labelled `image/jpeg` still previews, as a PNG.
      return detected !== null && isSafeImage(detected)
        ? { kind: 'image', mimeType: detected }
        : null;
    }
    case 'pdf': {
      if (detected !== 'application/pdf') return null;
      const hasNotes = attachmentFactsOf({ name, mimeType, content }).notes.length > 0;
      return hasNotes ? null : { kind: 'pdf' };
    }
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

// Notes

/**
 * Each program type: what it is called in a note, and the extensions and declared types it honestly
 * goes under. A Linux or macOS executable commonly has no extension at all; a Windows one never does.
 */
const PROGRAMS: Record<
  ProgramType,
  {
    readonly label: string;
    readonly extensions: ReadonlySet<string>;
    readonly isBareNameHonest: boolean;
  }
> = {
  'application/vnd.microsoft.portable-executable': {
    label: 'a Windows executable',
    extensions: new Set(['exe', 'dll', 'scr', 'com', 'cpl', 'sys', 'ocx', 'drv', 'efi', 'pif']),
    isBareNameHonest: false,
  },
  'application/x-executable': {
    label: 'a Linux executable',
    extensions: new Set(['so', 'o', 'elf', 'bin', 'run', 'out', 'ko', 'appimage']),
    isBareNameHonest: true,
  },
  'application/x-mach-binary': {
    label: 'a macOS executable',
    extensions: new Set(['dylib', 'bundle', 'so', 'o', 'out']),
    isBareNameHonest: true,
  },
  'application/x-ms-shortcut': {
    label: 'a Windows shortcut',
    extensions: new Set(['lnk']),
    isBareNameHonest: false,
  },
};

/** Declared types that say "a program", whichever platform's. */
const PROGRAM_LABELS = new Set([
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-elf',
  'application/x-sharedlib',
  'application/x-object',
  'application/x-mach-binary',
  'application/x-ms-shortcut',
]);

const PAGES: Record<
  PageType,
  {
    readonly label: string;
    readonly extensions: ReadonlySet<string>;
    readonly types: ReadonlySet<string>;
  }
> = {
  'text/html': {
    label: 'an HTML page',
    extensions: new Set(['html', 'htm', 'xhtml', 'xht', 'shtml']),
    types: new Set(['text/html', 'application/xhtml+xml']),
  },
  'image/svg+xml': {
    label: 'an SVG image',
    extensions: new Set(['svg']),
    types: new Set(['image/svg+xml']),
  },
};

/**
 * Formats that are not markup, so markup under one of their names is in disguise. Text and source
 * files are left out on purpose: a README or a template that opens with `<div>` is not lying.
 */
const DOCUMENT_EXTENSIONS = new Set([
  ...['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'],
  ...['pages', 'numbers', 'key', 'epub'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'tif', 'tiff', 'ico'],
  ...['zip', 'rar', '7z', 'gz', 'tar'],
  ...['mp3', 'm4a', 'wav', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm'],
]);

const isDocumentLabel = (label: string) =>
  label === 'application/pdf' ||
  label === 'application/zip' ||
  label === 'application/msword' ||
  label === 'application/rtf' ||
  /^(?:image|audio|video)\//u.test(label) ||
  /^application\/vnd\.(?:openxmlformats-officedocument|ms-|oasis\.opendocument)/u.test(label);

/**
 * Every markup name and type. HTML under an SVG's name or SVG under an HTML one is not a disguise:
 * both render in a browser, and a drawing that opens with a long comment is read as HTML.
 */
const PAGE_EXTENSIONS = new Set(Object.values(PAGES).flatMap(({ extensions }) => [...extensions]));
const PAGE_LABELS = new Set(Object.values(PAGES).flatMap(({ types }) => [...types]));

/**
 * Scripts and source a double extension may hide behind a document's: `invoice.pdf.js` runs in
 * Windows Script Host on a double-click. Alone, as `build.js`, they are code people mail.
 */
const SCRIPT_EXTENSIONS = new Set([
  ...['js', 'mjs', 'cjs', 'ts', 'py', 'pyw', 'sh', 'bash', 'zsh', 'ps1', 'psm1'],
  ...['pl', 'rb', 'php', 'lua', 'applescript', 'scpt'],
]);

/**
 * What opening a file of each extension starts, by the platform that runs it. Source code (`.py`,
 * `.sh`, `.js`) is not here: it opens in an editor, and people mail code.
 */
const RUNS_WHEN_OPENED = new Map<string, string>([
  ...['exe', 'com', 'pif', 'scr', 'cpl'].map(
    extension => [extension, 'a Windows executable'] as const,
  ),
  ...['bat', 'cmd'].map(extension => [extension, 'a Windows batch script'] as const),
  ...['vbs', 'vbe', 'jse', 'wsf', 'wsh'].map(extension => [extension, 'a Windows script'] as const),
  ['hta', 'an HTML application'],
  ...['msi', 'msp', 'msix', 'appx'].map(extension => [extension, 'a Windows installer'] as const),
  ['lnk', 'a Windows shortcut'],
  ['reg', 'a Windows registry file'],
  ['jar', 'a Java archive'],
  ['command', 'a macOS command script'],
  ...['pkg', 'mpkg'].map(extension => [extension, 'a macOS installer'] as const),
  ['appimage', 'a Linux executable'],
]);

/** What makes a claim about a file: its name's extension, or the type the sender declared. */
type Claim =
  | { readonly by: 'name'; readonly extension: string | null }
  | { readonly by: 'type'; readonly mimeType: string };

export type AttachmentNote =
  /** The bytes are a program; the name or the declared type says it is something else. */
  | { readonly code: 'program-misnamed'; readonly program: ProgramType; readonly claim: Claim }
  /** The bytes are HTML or SVG; the name or the declared type is a document, image or archive's. */
  | { readonly code: 'page-misnamed'; readonly page: PageType; readonly claim: Claim }
  /** A document's extension, then the real one: `invoice.pdf.exe`. */
  | { readonly code: 'double-extension'; readonly shown: string; readonly extension: string }
  /** The extension is one the system runs as a program when the file is opened. */
  | { readonly code: 'runs-when-opened'; readonly extension: string };

export type AttachmentNoteCode = AttachmentNote['code'];

const claimText = (claim: Claim) => {
  if (claim.by === 'type') return `its declared type is ${claim.mimeType}`;
  return claim.extension === null ? 'it has no extension' : `its extension is .${claim.extension}`;
};

/**
 * The one sentence for each note, so every client states it in the same words. A fact about the
 * file, never a verdict on it.
 */
export const noteText = (note: AttachmentNote): string => {
  switch (note.code) {
    case 'program-misnamed':
      return `This file is ${PROGRAMS[note.program].label}, but ${claimText(note.claim)}.`;
    case 'page-misnamed':
      return `This file is ${PAGES[note.page].label}, but ${claimText(note.claim)}.`;
    case 'double-extension':
      return `This name contains .${note.shown}, but its extension is .${note.extension}.`;
    case 'runs-when-opened':
      return `The .${note.extension} extension identifies ${RUNS_WHEN_OPENED.get(note.extension) ?? 'a file that can run when opened'}, which may run when opened.`;
  }
};

/** A program whose name or declared type is not a program's, and which of the two says so. */
const programClaim = (
  program: ProgramType,
  extension: string | null,
  label: string,
): Claim | null => {
  const { extensions, isBareNameHonest } = PROGRAMS[program];
  const isNameHonest = extension === null ? isBareNameHonest : extensions.has(extension);
  if (!isNameHonest) return { by: 'name', extension };
  if (GENERIC_LABELS.has(label) || PROGRAM_LABELS.has(label)) return null;
  return { by: 'type', mimeType: label };
};

/** Markup under a document's, an image's or an archive's name or declared type, not markup's. */
const pageClaim = (extension: string | null, label: string): Claim | null => {
  // No markup extension is a document's, so only the declared type needs the markup exception.
  if (extension !== null && DOCUMENT_EXTENSIONS.has(extension)) {
    return { by: 'name', extension };
  }
  if (!PAGE_LABELS.has(label) && isDocumentLabel(label)) return { by: 'type', mimeType: label };
  return null;
};

const isProgram = (type: DetectedType): type is ProgramType => Object.hasOwn(PROGRAMS, type);
const isPage = (type: DetectedType): type is PageType => Object.hasOwn(PAGES, type);

const contentNote = (
  detected: DetectedType | null,
  extension: string | null,
  label: string,
): AttachmentNote | null => {
  if (detected === null) return null;
  if (isProgram(detected)) {
    const claim = programClaim(detected, extension, label);
    return claim === null ? null : { code: 'program-misnamed', program: detected, claim };
  }
  if (isPage(detected)) {
    const claim = pageClaim(extension, label);
    return claim === null ? null : { code: 'page-misnamed', page: detected, claim };
  }
  return null;
};

/**
 * Extensions a double extension may hide behind the first: what runs, what a browser renders, and
 * scripts.
 */
const isHiddenExtension = (extension: string) =>
  RUNS_WHEN_OPENED.has(extension) ||
  PAGE_EXTENSIONS.has(extension) ||
  SCRIPT_EXTENSIONS.has(extension);

/**
 * What the first of a double extension may pretend to be: a document's, an image's, media or an
 * archive's, or any kind this module previews (text, logs, CSV, Markdown included).
 */
const SHOWN_EXTENSIONS = new Set([...DOCUMENT_EXTENSIONS, ...KIND_BY_EXTENSION.keys()]);

const doubleExtensionNote = (saved: string, extension: string | null): AttachmentNote | null => {
  if (extension === null || !isHiddenExtension(extension)) return null;
  const shown = extensionOf(stemOf(saved));
  if (shown === null || !SHOWN_EXTENSIONS.has(shown)) return null;
  return { code: 'double-extension', shown, extension };
};

export type AttachmentFacts = {
  /** What the bytes are, or null when they match no known type or were not read. */
  readonly detectedType: DetectedType | null;
  /** Empty for a file that is what it says. */
  readonly notes: readonly AttachmentNote[];
};

/**
 * What every client states about an attachment: the type its bytes identify, and every note on it,
 * from its saved name as it is drawn (`savedName`, then `drawnName`), its declared type and, when present, its bytes. Without bytes
 * (a file not read yet) only the name and the type speak.
 */
export const attachmentFactsOf = ({
  name,
  mimeType,
  content,
}: {
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly content?: Uint8Array | null | undefined;
}): AttachmentFacts => {
  const drawn = drawnName(savedName(name));
  const extension = extensionOf(drawn);
  const detectedType = content == null ? null : detectedTypeOf(content);
  const notes = [
    contentNote(detectedType, extension, mimeTypeOf(mimeType)),
    doubleExtensionNote(drawn, extension),
    extension !== null && RUNS_WHEN_OPENED.has(extension)
      ? { code: 'runs-when-opened' as const, extension }
      : null,
  ].filter(note => note !== null);
  return { detectedType, notes };
};

/**
 * The facts as a surface that prints JSON prints them, beside the sender's declared type: the CLI's
 * `read` and the agent tools alike. Each is omitted when empty.
 */
export const attachmentFactFields = ({ detectedType, notes }: AttachmentFacts) => ({
  ...(detectedType === null ? {} : { detectedType }),
  ...(notes.length === 0
    ? {}
    : { notes: notes.map(note => ({ code: note.code, text: noteText(note) })) }),
});

/** The one description of an attachment's `detectedType`, for the CLI and the agent tools alike. */
export const DETECTED_TYPE_DESCRIPTION =
  'detectedType is the file type identified from its bytes, when recognised.';

/** The one description of an attachment's `notes`, for the CLI and the agent tools alike. */
export const ATTACHMENT_NOTES_DESCRIPTION =
  "notes describe what YOZZ found in the file's bytes and name; they are not a malware scan or a verdict on whether the file is harmful.";
