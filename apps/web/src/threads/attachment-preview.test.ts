import { describe, expect, it } from 'vitest';
import { decodeText, displayName, MAX_TEXT_PREVIEW_BYTES, previewOf } from './attachment-preview';
import type { Attachment } from './thread';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap(part =>
      typeof part === 'string' ? Array.from(new TextEncoder().encode(part)) : part,
    ),
  );

const file = (
  mimeType: string | undefined,
  content: Uint8Array<ArrayBuffer> | undefined,
  name = 'f',
) =>
  ({
    name,
    size: content?.byteLength ?? 0,
    kind: 'other',
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(content === undefined ? {} : { content }),
  }) satisfies Attachment;

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF');
const HTML = bytes('<html><script>alert(1)</script></html>');
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF = bytes('%PDF-1.7\n1 0 obj\n');
/** An ISO-BMFF `ftyp` box: size, `ftyp`, major brand, minor version, compatible brands. */
const ftyp = (major: string, minor: string, ...compatible: string[]) =>
  bytes([0, 0, 0, 16 + compatible.length * 4], 'ftyp', major, minor, ...compatible);

describe('previewOf', () => {
  it('previews an allowlisted raster whose bytes say so, under the type the bytes name', () => {
    expect(previewOf(file('image/png', PNG))).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(previewOf(file('IMAGE/JPEG', JPEG))).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
    expect(previewOf(file('image/jpeg', PNG))).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(previewOf(file('image/gif', bytes('GIF89a')))).toEqual({
      kind: 'image',
      mimeType: 'image/gif',
    });
    expect(previewOf(file('image/webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')))).toEqual({
      kind: 'image',
      mimeType: 'image/webp',
    });
    expect(previewOf(file('image/avif', ftyp('avif', '\0\0\0\0', 'mif1')))).toEqual({
      kind: 'image',
      mimeType: 'image/avif',
    });
    expect(previewOf(file('image/avif', ftyp('mif1', '\0\0\0\0', 'miaf', 'avif')))).toEqual({
      kind: 'image',
      mimeType: 'image/avif',
    });
  });

  it('refuses markup labelled as an image, and SVG under any label', () => {
    expect(previewOf(file('image/png', HTML))).toBeNull();
    expect(previewOf(file('image/png', SVG))).toBeNull();
    expect(previewOf(file('image/svg+xml', SVG))).toBeNull();
    // The minor version is not a brand.
    expect(previewOf(file('image/avif', ftyp('mif1', 'avif')))).toBeNull();
  });

  it('reads no further than a real ftyp box could reach', () => {
    // A box declaring 4 GiB over 20 MiB of padding: it is not an image header, and must not be walked.
    const crafted = new Uint8Array(20 * 1024 * 1024);
    crafted.set([0xff, 0xff, 0xff, 0xff, ...new TextEncoder().encode('ftypmif1\0\0\0\0avif')]);
    const started = performance.now();
    expect(previewOf(file('image/avif', crafted))).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    // Just past the cap is not AVIF either, whatever brands it names.
    const oversized = new Uint8Array(512);
    oversized.set([0, 0, 1, 4, ...new TextEncoder().encode('ftypavif')]);
    expect(previewOf(file('image/avif', oversized))).toBeNull();
  });

  it('refuses a raster the sender did not call an image', () => {
    expect(previewOf(file('application/octet-stream', PNG))).toBeNull();
    expect(previewOf(file('text/html', PNG))).toBeNull();
  });

  it('opens a PDF only when it starts as one', () => {
    expect(previewOf(file('application/pdf', PDF))).toEqual({ kind: 'pdf' });
    expect(previewOf(file('application/pdf', HTML))).toBeNull();
    expect(previewOf(file('application/pdf', bytes(' %PDF-1.7')))).toBeNull();
    expect(previewOf(file('text/html', PDF))).toBeNull();
  });

  it('shows text that is text, markup included, and never HTML', () => {
    expect(previewOf(file('text/plain', HTML))).toEqual({ kind: 'text' });
    expect(previewOf(file('text/csv', bytes('a,b\n1,2')))).toEqual({ kind: 'text' });
    expect(previewOf(file('text/html', HTML))).toBeNull();
    expect(previewOf(file('text/plain', bytes('MZ', [0x90, 0x00, 0x03])))).toBeNull();
    // UTF-16 is all NULs to a byte scan; its byte order mark says it is text.
    expect(previewOf(file('text/plain', bytes([0xff, 0xfe], 'h', [0], 'i', [0])))).toEqual({
      kind: 'text',
    });
  });

  it('leaves text over the cap to the download', () => {
    const atCap = new Uint8Array(MAX_TEXT_PREVIEW_BYTES).fill(0x61);
    expect(previewOf(file('text/plain', atCap))).toEqual({ kind: 'text' });
    expect(
      previewOf(file('text/plain', new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1).fill(0x61))),
    ).toBeNull();
  });

  it('needs the bytes, and a label or an extension that says what they are', () => {
    expect(previewOf(file('image/png', undefined))).toBeNull();
    expect(previewOf(file(undefined, PNG))).toBeNull();
    expect(previewOf(file('application/octet-stream', PNG))).toBeNull();
  });

  it('takes the claim from the extension under a generic label, and still checks the bytes', () => {
    expect(previewOf(file('application/octet-stream', PNG, 'scan.PNG'))).toEqual({
      kind: 'image',
      mimeType: 'image/png',
    });
    // The bytes still name the type: a PNG called `.jpg` previews as a PNG.
    expect(previewOf(file(undefined, PNG, 'photo.jpg'))).toEqual({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(previewOf(file('application/octet-stream', PDF, 'receipt.pdf'))).toEqual({
      kind: 'pdf',
    });
    expect(previewOf(file('', bytes('build failed\n'), 'build.log'))).toEqual({ kind: 'text' });
    expect(previewOf(file('application/octet-stream', bytes('a,b\n'), 'fees.csv'))).toEqual({
      kind: 'text',
    });
    // Read from the name as saved, bidi controls removed: this one is saved as `photo.png`.
    expect(
      previewOf(file('application/octet-stream', PNG, `photo.p${String.fromCharCode(0x202e)}ng`)),
    ).toEqual({ kind: 'image', mimeType: 'image/png' });
  });

  it('refuses a generic label whose bytes disagree with the extension, or an unknown extension', () => {
    expect(previewOf(file('application/octet-stream', HTML, 'photo.png'))).toBeNull();
    expect(previewOf(file('application/octet-stream', SVG, 'logo.png'))).toBeNull();
    expect(previewOf(file('application/octet-stream', HTML, 'statement.pdf'))).toBeNull();
    expect(
      previewOf(file('application/octet-stream', bytes('MZ', [0x90, 0x00]), 'a.txt')),
    ).toBeNull();
    expect(previewOf(file('application/octet-stream', HTML, 'page.html'))).toBeNull();
    expect(previewOf(file('application/octet-stream', SVG, 'logo.svg'))).toBeNull();
    expect(previewOf(file('application/octet-stream', PNG, 'image.constructor'))).toBeNull();
  });

  it('ignores the extension under a specific label', () => {
    expect(previewOf(file('application/zip', PNG, 'photo.png'))).toBeNull();
    expect(previewOf(file('text/html', PDF, 'receipt.pdf'))).toBeNull();
  });
});

describe('decodeText', () => {
  it('reads UTF-8, dropping its byte order mark, and UTF-16 by its mark', () => {
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], 'café'))).toBe('café');
    expect(decodeText(bytes([0xff, 0xfe], 'h', [0], 'i', [0]))).toBe('hi');
    expect(decodeText(bytes([0xfe, 0xff], [0], 'h', [0], 'i'))).toBe('hi');
  });

  it('marks what is not UTF-8 rather than failing', () => {
    expect(decodeText(bytes('caf', [0xe9]))).toBe('caf\ufffd');
  });
});

describe('displayName', () => {
  it('removes the bidi controls that would disguise an extension', () => {
    expect(displayName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(displayName('a\u2066b\u2069\u200f.txt')).toBe('ab.txt');
    expect(displayName('رسالة.pdf')).toBe('رسالة.pdf');
  });
});
