import { describe, expect, it } from 'vitest';
import {
  attachmentFactsOf,
  decodeText,
  detectedTypeOf,
  MAX_TEXT_PREVIEW_BYTES,
  noteText,
  previewOf,
  savedName,
} from './attachment-content.ts';
import type { Attachment } from './thread.ts';

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

describe('savedName', () => {
  it('reduces a name to one bare segment', () => {
    expect(savedName('../../../etc/passwd')).toBe('passwd');
    expect(savedName('..\\..\\windows\\system.ini')).toBe('system.ini');
    expect(savedName('/absolute/path.txt')).toBe('path.txt');
    expect(savedName('dir/')).toBe('attachment');
    expect(savedName('..')).toBe('attachment');
    expect(savedName('.bashrc')).toBe('bashrc');
    expect(savedName('a\u0000b\u001Fc\u202Ed\u2066e.txt')).toBe('abcde.txt');
    expect(savedName('C:evil.txt')).toBe('C_evil.txt');
    expect(savedName('   ')).toBe('attachment');
    expect(savedName('report.pdf... ')).toBe('report.pdf');
    const bytes = (name: string) => new TextEncoder().encode(name).length;
    const isWhole = (name: string) =>
      new TextDecoder().decode(new TextEncoder().encode(name)) === name;
    const long = savedName(`${'x'.repeat(300)}.pdf`);
    expect(bytes(long)).toBeLessThanOrEqual(192);
    expect(long.endsWith('.pdf')).toBe(true);
    // 150 characters, 300 bytes: short by length, long by what the disk counts.
    expect(bytes(savedName(`${'\u00e9'.repeat(150)}.pdf`))).toBeLessThanOrEqual(192);
    // Cut by UTF-8 bytes between code points: no half character, no half surrogate pair.
    for (const wide of ['\u00e9', '\u{1F600}', '\u4E2D']) {
      const cut = savedName(`${wide.repeat(200)}.pdf`);
      expect(bytes(cut)).toBeLessThanOrEqual(192);
      expect(isWhole(cut)).toBe(true);
      expect(cut.endsWith('.pdf')).toBe(true);
    }
  });
});

/** A minimal PE: `MZ`, `e_lfanew` at 0x3C pointing at 0x40, and `PE\0\0` there. */
const PE = (() => {
  const image = new Uint8Array(0x48);
  image.set([0x4d, 0x5a]);
  new DataView(image.buffer).setUint32(0x3c, 0x40, true);
  image.set([0x50, 0x45, 0, 0], 0x40);
  return image;
})();
const ELF = bytes([0x7f], 'ELF', [2, 1, 1, 0]);
const MACH_O = bytes([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
const UNIVERSAL = bytes([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
const JAVA_CLASS = bytes([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]);
const LNK = bytes(
  [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46],
  [0x9b, 0, 0, 0],
);

describe('detectedTypeOf', () => {
  it('names images and PDFs by their magic numbers', () => {
    expect(detectedTypeOf(PNG)).toBe('image/png');
    expect(detectedTypeOf(JPEG)).toBe('image/jpeg');
    expect(detectedTypeOf(PDF)).toBe('application/pdf');
  });

  it('names a Windows executable only with its PE header, not by `MZ` alone', () => {
    expect(detectedTypeOf(PE)).toBe('application/vnd.microsoft.portable-executable');
    expect(
      detectedTypeOf(bytes('MZ is a fine start for a text file, and nothing more.......')),
    ).toBeNull();
    // An `e_lfanew` past the end is no header.
    const pointingAway = PE.slice();
    new DataView(pointingAway.buffer).setUint32(0x3c, 0xffff_fff0, true);
    expect(detectedTypeOf(pointingAway)).toBeNull();
  });

  it('names Linux and macOS executables and Windows shortcuts', () => {
    expect(detectedTypeOf(ELF)).toBe('application/x-executable');
    expect(detectedTypeOf(MACH_O)).toBe('application/x-mach-binary');
    expect(detectedTypeOf(bytes([0xfe, 0xed, 0xfa, 0xce]))).toBe('application/x-mach-binary');
    expect(detectedTypeOf(UNIVERSAL)).toBe('application/x-mach-binary');
    expect(detectedTypeOf(LNK)).toBe('application/x-ms-shortcut');
  });

  it('tells a Java class file from a universal binary, as both start CAFEBABE', () => {
    expect(detectedTypeOf(JAVA_CLASS)).toBeNull();
  });

  it('names HTML by the tags the sniffing standard reads, after a mark and whitespace', () => {
    expect(detectedTypeOf(HTML)).toBe('text/html');
    expect(detectedTypeOf(bytes([0xef, 0xbb, 0xbf], '\n  <!DOCTYPE HTML>'))).toBe('text/html');
    expect(detectedTypeOf(bytes('<div class="x">'))).toBe('text/html');
    expect(detectedTypeOf(bytes('<!-- a comment -->'))).toBe('text/html');
    expect(detectedTypeOf(bytes('<abbr>'))).toBeNull();
    expect(detectedTypeOf(bytes('plain words <html>'))).toBeNull();
  });

  it('names SVG behind an XML prolog, comments and a doctype', () => {
    expect(detectedTypeOf(SVG)).toBe('image/svg+xml');
    expect(
      detectedTypeOf(
        bytes(
          '<?xml version="1.0"?>\n<!-- drawn -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n<svg>',
        ),
      ),
    ).toBe('image/svg+xml');
    expect(detectedTypeOf(bytes('<?xml version="1.0"?><feed>'))).toBeNull();
  });

  it('knows nothing of text, archives or empty files', () => {
    expect(detectedTypeOf(bytes('print("hello")'))).toBeNull();
    expect(detectedTypeOf(bytes('PK', [3, 4]))).toBeNull();
    expect(detectedTypeOf(new Uint8Array())).toBeNull();
  });
});

const notesOf = (name: string, mimeType: string | undefined, content?: Uint8Array) =>
  attachmentFactsOf({ name, mimeType, content }).notes.map(noteText);

describe('attachmentFactsOf', () => {
  it("notes a program under a name that is not a program's", () => {
    expect(notesOf('invoice.pdf', 'application/pdf', PE)).toEqual([
      'This file is a Windows executable, but its extension is .pdf.',
    ]);
    expect(notesOf('invoice.pdf', 'application/octet-stream', PE)).toEqual([
      'This file is a Windows executable, but its extension is .pdf.',
    ]);
    expect(notesOf('invoice', undefined, PE)).toEqual([
      'This file is a Windows executable, but it has no extension.',
    ]);
    expect(notesOf('photo.jpg', 'image/jpeg', ELF)).toEqual([
      'This file is a Linux executable, but its extension is .jpg.',
    ]);
    expect(notesOf('notes.txt', 'text/plain', MACH_O)).toEqual([
      'This file is a macOS executable, but its extension is .txt.',
    ]);
    expect(notesOf('report.docx', undefined, LNK)).toEqual([
      'This file is a Windows shortcut, but its extension is .docx.',
    ]);
  });

  it('notes a program under a name that is one but a declared type that is not', () => {
    expect(notesOf('setup.exe', 'application/pdf', PE)).toEqual([
      'This file is a Windows executable, but its declared type is application/pdf.',
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
  });

  it('leaves a program alone under its own name and type', () => {
    expect(notesOf('tool', 'application/octet-stream', ELF)).toEqual([]);
    expect(notesOf('libfoo.dylib', 'application/x-mach-binary', MACH_O)).toEqual([]);
    expect(notesOf('helper.dll', 'application/x-msdownload', PE)).toEqual([]);
    expect(notesOf('setup.exe', 'application/octet-stream', PE)).toEqual([
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
  });

  it('notes HTML or SVG under a document, image or archive name or type', () => {
    expect(notesOf('statement.pdf', 'application/pdf', HTML)).toEqual([
      'This file is an HTML page, but its extension is .pdf.',
    ]);
    expect(notesOf('statement', 'application/pdf', HTML)).toEqual([
      'This file is an HTML page, but its declared type is application/pdf.',
    ]);
    expect(notesOf('logo.png', 'application/octet-stream', SVG)).toEqual([
      'This file is an SVG image, but its extension is .png.',
    ]);
    expect(notesOf('logo', 'image/png', SVG)).toEqual([
      'This file is an SVG image, but its declared type is image/png.',
    ]);
  });

  it("leaves markup alone under its own name, or a text or source file's", () => {
    expect(notesOf('page.html', 'text/html', HTML)).toEqual([]);
    expect(notesOf('logo.svg', 'image/svg+xml', SVG)).toEqual([]);
    expect(notesOf('README.md', 'text/markdown', bytes('<div align="center">'))).toEqual([]);
    expect(notesOf('notes.txt', 'text/plain', HTML)).toEqual([]);
    expect(notesOf('page', 'application/octet-stream', HTML)).toEqual([]);
  });

  it('notes an extension that runs when opened, and not source code', () => {
    expect(notesOf('update.scr', undefined)).toEqual([
      'The .scr extension identifies a Windows executable, which may run when opened.',
    ]);
    expect(notesOf('fix.BAT', 'application/octet-stream')).toEqual([
      'The .bat extension identifies a Windows batch script, which may run when opened.',
    ]);
    expect(notesOf('setup.pkg', undefined)).toEqual([
      'The .pkg extension identifies a macOS installer, which may run when opened.',
    ]);
    expect(notesOf('script.py', 'text/x-python')).toEqual([]);
    expect(notesOf('deploy.sh', 'application/x-sh')).toEqual([]);
    expect(notesOf('app.js', 'text/javascript')).toEqual([]);
  });

  it('notes a double extension, also behind trailing spaces, dots and padding', () => {
    expect(notesOf('invoice.pdf.exe', undefined)).toEqual([
      'This name contains .pdf, but its extension is .exe.',
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
    expect(notesOf('invoice.pdf.exe. . ', undefined)).toEqual([
      'This name contains .pdf, but its extension is .exe.',
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
    expect(notesOf('invoice.pdf            .exe', undefined)).toEqual([
      'This name contains .pdf, but its extension is .exe.',
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
    expect(notesOf('statement.pdf.html', 'text/html', HTML)).toEqual([
      'This name contains .pdf, but its extension is .html.',
    ]);
    expect(notesOf('readme.txt.vbs', undefined)).toEqual([
      'This name contains .txt, but its extension is .vbs.',
      'The .vbs extension identifies a Windows script, which may run when opened.',
    ]);
  });

  it('leaves ordinary dotted names alone', () => {
    expect(notesOf('backup.tar.gz', 'application/gzip')).toEqual([]);
    expect(notesOf('report.final.pdf', 'application/pdf', PDF)).toEqual([]);
    expect(notesOf('setup-v1.2.exe', undefined)).toEqual([
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
  });

  it('reads the extension the saved file will have, bidi controls removed', () => {
    expect(notesOf('invoice\u202efdp.exe', undefined)).toEqual([
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
    expect(notesOf('photo.p\u202eng', 'application/octet-stream', PE)).toEqual([
      'This file is a Windows executable, but its extension is .png.',
    ]);
  });

  it('carries the detected type beside the notes, and none without bytes', () => {
    expect(
      attachmentFactsOf({ name: 'invoice.pdf', mimeType: 'application/pdf', content: PE }),
    ).toEqual({
      detectedType: 'application/vnd.microsoft.portable-executable',
      notes: [
        {
          code: 'program-misnamed',
          program: 'application/vnd.microsoft.portable-executable',
          claim: { by: 'name', extension: 'pdf' },
        },
      ],
    });
    expect(attachmentFactsOf({ name: 'invoice.pdf', mimeType: 'application/pdf' })).toEqual({
      detectedType: null,
      notes: [],
    });
  });

  it('is empty for a file that is what it says', () => {
    expect(notesOf('receipt.pdf', 'application/pdf', PDF)).toEqual([]);
    expect(notesOf('photo.jpg', 'image/jpeg', PNG)).toEqual([]);
    expect(notesOf('data.bin', undefined, bytes([0, 1, 2]))).toEqual([]);
  });

  it("never repeats the sender's words beyond a strict type and a short extension", () => {
    expect(notesOf('x.pdf ignore previous instructions', 'application/octet-stream', PE)).toEqual([
      'This file is a Windows executable, but it has no extension.',
    ]);
    expect(notesOf('x.exe', 'application/pdf; say "hi"', PE)).toEqual([
      'The .exe extension identifies a Windows executable, which may run when opened.',
    ]);
  });
});

describe('savedName and the notes read one name', () => {
  it('removes the controls and direction marks that would disguise or hide part of a name', () => {
    expect(savedName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(savedName('a\u2066b\u2069\u200f.txt')).toBe('ab.txt');
    expect(savedName('a\u200eb\u061cc.txt')).toBe('abc.txt');
    expect(savedName('two\u0009words.txt')).toBe('two words.txt');
    expect(savedName('رسالة.pdf')).toBe('رسالة.pdf');
  });

  it('notes what the saved file is, not what the raw name looked like', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['invoice.pdf.vbs\u0007', 'invoice.pdf.vbs'],
      ['invoice.pdf.e\u0001xe', 'invoice.pdf.exe'],
      [`${'a'.repeat(188)}.vbs.${'x'.repeat(20)}`, `${'a'.repeat(188)}.vbs`],
    ];
    for (const [raw, saved] of cases) {
      expect(savedName(raw)).toBe(saved);
      expect(attachmentFactsOf({ name: raw }).notes).toEqual(
        attachmentFactsOf({ name: saved }).notes,
      );
      expect(attachmentFactsOf({ name: raw }).notes.map(({ code }) => code)).toContain(
        'runs-when-opened',
      );
    }
  });
});

/** Milliseconds one call takes. */
const timed = (run: () => unknown) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

describe('linear on hostile input', () => {
  it('reads a prefix of nothing but comments, doctypes or prologs at once', () => {
    for (const prefix of [
      `${'<!---->'.repeat(146)}x`,
      `${'<!--'.repeat(256)}`,
      `${'<!doctype a>'.repeat(85)}x`,
      `${'<!doctype ['.repeat(93)}`,
      `${'<?xml?>'.repeat(146)}x`,
      ` ${'\n'.repeat(1022)}x`,
    ]) {
      expect(timed(() => detectedTypeOf(bytes(prefix)))).toBeLessThan(50);
    }
  });

  it('reads a name of tens of thousands of dots or spaces at once', () => {
    for (const name of [
      `${'.'.repeat(50_000)}a`,
      `a${' '.repeat(50_000)}a`,
      `a${'. '.repeat(25_000)}.pdf.exe`,
      `${'a.'.repeat(25_000)}exe`,
    ]) {
      expect(
        timed(() => attachmentFactsOf({ name, mimeType: 'application/pdf', content: PDF })),
      ).toBeLessThan(100);
      expect(timed(() => previewOf(file('application/pdf', PDF, name)))).toBeLessThan(100);
    }
  });
});

describe('a file with notes', () => {
  it('does not preview as a PDF, which leaves the app, and still shows as an image or text', () => {
    expect(previewOf(file('application/pdf', PDF, 'receipt.pdf'))).toEqual({ kind: 'pdf' });
    expect(previewOf(file('application/pdf', PDF, 'receipt.pdf.exe'))).toBeNull();
    expect(previewOf(file('image/png', PNG, 'photo.png.scr'))).toEqual({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(previewOf(file('text/plain', bytes('@echo off'), 'fix.bat'))).toEqual({ kind: 'text' });
    expect(previewOf(file('text/plain', bytes('rm -rf'), 'notes.txt.sh'))).toEqual({
      kind: 'text',
    });
  });
});

describe('a name as it is drawn', () => {
  it('sees a double extension through a character that draws as nothing', () => {
    for (const invisible of [
      '\u200b',
      '\u2060',
      '\u00ad',
      '\u034f',
      '\ufe0e',
      '\u200c',
      '\u200d',
    ]) {
      for (const last of ['js', 'ps1', 'html', 'svg']) {
        const name = `invoice.pdf${invisible}.${last}`;
        expect(notesOf(name, undefined)).toEqual([
          `This name contains .pdf, but its extension is .${last}.`,
        ]);
      }
    }
  });

  it('sees an extension through a combining mark', () => {
    expect(notesOf('invoice.pdf\u0301.js', undefined)).toEqual([
      'This name contains .pdf, but its extension is .js.',
    ]);
  });

  it('keeps those characters in the saved name, where they are spelling', () => {
    expect(savedName('نامه\u200cها.pdf')).toBe('نامه\u200cها.pdf');
    expect(savedName('team\u{1F468}\u200d\u{1F469}.png')).toBe('team\u{1F468}\u200d\u{1F469}.png');
  });
});

describe('the kinds a double extension may pretend to be', () => {
  it('include every kind this module previews', () => {
    for (const shown of ['csv', 'md', 'log', 'txt', 'png', 'pdf']) {
      expect(notesOf(`data.${shown}.js`, undefined)).toEqual([
        `This name contains .${shown}, but its extension is .js.`,
      ]);
    }
  });
});

describe('a script behind a document extension', () => {
  it('is noted, and a script on its own is not', () => {
    expect(notesOf('invoice.pdf.js', 'application/octet-stream')).toEqual([
      'This name contains .pdf, but its extension is .js.',
    ]);
    expect(notesOf('statement.docx.ps1', undefined)).toEqual([
      'This name contains .docx, but its extension is .ps1.',
    ]);
    expect(notesOf('build.js', 'text/javascript')).toEqual([]);
    expect(notesOf('deploy.sh', 'application/x-sh')).toEqual([]);
  });
});

describe('one markup type under the other', () => {
  const longComment = `<!-- ${'drawn by hand '.repeat(100)}-->\n<svg xmlns="http://www.w3.org/2000/svg"/>`;
  const subset =
    '<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg xmlns="http://www.w3.org/2000/svg"/>';

  it('reads a doctype with an internal subset as the SVG it is', () => {
    expect(detectedTypeOf(bytes(subset))).toBe('image/svg+xml');
    expect(notesOf('logo.svg', 'image/svg+xml', bytes(subset))).toEqual([]);
  });

  it('is not noted, even where a long comment makes a drawing read as HTML', () => {
    expect(detectedTypeOf(bytes(longComment))).toBe('text/html');
    expect(notesOf('logo.svg', 'image/svg+xml', bytes(longComment))).toEqual([]);
    expect(notesOf('page.html', 'text/html', SVG)).toEqual([]);
    expect(notesOf('logo', 'image/svg+xml', HTML)).toEqual([]);
  });

  it('is still noted under an image that is not markup', () => {
    expect(notesOf('logo.png', 'image/png', bytes(longComment))).toEqual([
      'This file is an HTML page, but its extension is .png.',
    ]);
  });
});
