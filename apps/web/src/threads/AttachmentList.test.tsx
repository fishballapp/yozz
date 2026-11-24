// @vitest-environment jsdom

import type { Attachment } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentList } from './AttachmentList';

const encode = (text: string) => new TextEncoder().encode(text);

const PNG: Attachment = {
  name: 'chart.png',
  size: 12,
  kind: 'image',
  mimeType: 'image/png',
  content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
};
const TEXT: Attachment = {
  name: 'notes.txt',
  size: 40,
  kind: 'other',
  mimeType: 'text/plain',
  content: encode('<b id="pwn">bold?</b><script>window.ran = 1</script>'),
};
const PDF: Attachment = {
  name: 'receipt.pdf',
  size: 9,
  kind: 'pdf',
  mimeType: 'application/pdf',
  content: encode('%PDF-1.7\n'),
};
const HTML_AS_PDF: Attachment = { ...PDF, name: 'fake.pdf', content: encode('<html></html>') };

/** Every object URL made, by the type of the blob behind it, and every one revoked. */
const made: { url: string; type: string }[] = [];
const revoked: string[] = [];
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  made.length = 0;
  revoked.length = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:test/${made.length}`;
      made.push({ url, type: blob.type });
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = (attachments: Attachment[]) => {
  root = createRoot(container);
  act(() => root?.render(<AttachmentList attachments={attachments} />));
};

const button = (name: string) => {
  const found = Array.from(document.querySelectorAll('button')).find(
    candidate => candidate.getAttribute('aria-label') === name,
  );
  if (found === undefined) throw new Error(`No button named ${name}`);
  return found;
};

const labels = () =>
  Array.from(container.querySelectorAll('button')).map(each => each.getAttribute('aria-label'));

describe('AttachmentList', () => {
  it('splits a chip that previews into open and download, and leaves the rest a download', () => {
    render([PNG, PDF, HTML_AS_PDF]);
    expect(labels()).toEqual([
      'Preview chart.png, 12 B',
      'Download chart.png',
      'Open receipt.pdf in a new tab, 9 B',
      'Download receipt.pdf',
      'Download fake.pdf, 9 B',
    ]);
  });

  describe('a file kept in R2', () => {
    const STORED: Attachment = {
      name: 'receipt.pdf',
      size: 9,
      kind: 'pdf',
      mimeType: 'application/pdf',
      fileId: 'file-1',
    };
    const renderStored = (
      loadFile: (fileId: string) => Promise<Uint8Array<ArrayBuffer> | null>,
    ) => {
      root ??= createRoot(container);
      act(() => root?.render(<AttachmentList attachments={[STORED]} loadFile={loadFile} />));
    };

    it('asks for nothing until it is clicked, then downloads what R2 holds', async () => {
      const asked: string[] = [];
      renderStored(async fileId => {
        asked.push(fileId);
        return new Uint8Array([1, 2, 3]);
      });
      expect(asked).toEqual([]);

      await act(async () => button('Download receipt.pdf, 9 B').click());

      expect(asked).toEqual(['file-1']);
      expect(made).toEqual([{ url: 'blob:test/0', type: 'application/octet-stream' }]);
    });

    it('says so when R2 no longer holds it, and can be tried again', async () => {
      renderStored(async () => null);
      await act(async () => button('Download receipt.pdf, 9 B').click());
      expect(container.textContent).toContain('Couldn’t download');
      expect(made).toEqual([]);
      expect(button('Download receipt.pdf, 9 B').disabled).toBe(false);
    });
  });

  it('tags a chip by what a click opens, and by its kind when it only downloads', () => {
    render([
      { ...PNG, name: 'scan.png', kind: 'other', mimeType: 'application/octet-stream' },
      { ...TEXT, kind: 'other' },
      PDF,
      { ...HTML_AS_PDF, name: 'archive.zip', kind: 'archive', mimeType: 'application/zip' },
    ]);
    const tags = Array.from(
      container.querySelectorAll('li'),
      item => item.querySelector('span')?.textContent,
    );
    expect(tags).toEqual(['IMG', 'TXT', 'PDF', 'HTML']);
  });

  /** A minimal PE: `MZ`, `e_lfanew` pointing at 0x40, and `PE\0\0` there. */
  const PROGRAM_AS_PDF: Attachment = (() => {
    const content = new Uint8Array(0x48);
    content.set([0x4d, 0x5a]);
    new DataView(content.buffer).setUint32(0x3c, 0x40, true);
    content.set([0x50, 0x45, 0, 0], 0x40);
    return { name: 'invoice.pdf', size: 72, kind: 'pdf', mimeType: 'application/pdf', content };
  })();

  describe('a file whose bytes or name are not what they claim', () => {
    it('still previews an image with notes, in the app, where nothing runs', () => {
      render([{ ...PNG, name: 'chart.png.scr' }]);
      expect(labels()).toEqual(['Preview chart.png.scr, 12 B', 'Download chart.png.scr']);
    });

    it('keeps an open question when a second stored file lands', async () => {
      const loads = new Map(
        ['file-a', 'file-b'].map(id => [id, Promise.withResolvers<Uint8Array<ArrayBuffer>>()]),
      );
      root = createRoot(container);
      act(() =>
        root?.render(
          <AttachmentList
            attachments={[
              { name: 'setup.exe', size: 3, kind: 'other', fileId: 'file-a' },
              { name: 'tool.scr', size: 3, kind: 'other', fileId: 'file-b' },
            ]}
            loadFile={fileId => {
              const load = loads.get(fileId);
              if (load === undefined) throw new Error(`no ${fileId}`);
              return load.promise;
            }}
          />,
        ),
      );
      await act(async () => button('Download setup.exe, 3 B').click());
      await act(async () => button('Download tool.scr, 3 B').click());
      await act(async () => loads.get('file-a')?.resolve(new Uint8Array([1, 2, 3])));
      expect(dialog()?.textContent).toContain('Download setup.exe?');
      await act(async () => loads.get('file-b')?.resolve(new Uint8Array([1, 2, 3])));
      expect(dialog()?.textContent).toContain('Download setup.exe?');
      expect(dialog()?.textContent).not.toContain('tool.scr');
      expect(made).toEqual([]);
    });

    it('does nothing when a fetch lands after its message is gone', async () => {
      const load = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
      root = createRoot(container);
      act(() =>
        root?.render(
          <AttachmentList
            attachments={[{ name: 'notes.txt', size: 3, kind: 'other', fileId: 'file-c' }]}
            loadFile={() => load.promise}
          />,
        ),
      );
      await act(async () => button('Download notes.txt, 3 B').click());
      act(() => root?.render(null));
      await act(async () => load.resolve(new Uint8Array([1, 2, 3])));
      expect(made).toEqual([]);
    });

    const dialog = () => document.querySelector('[role="alertdialog"]');

    it('is tagged by its bytes, and its note shows with the chip', () => {
      render([PROGRAM_AS_PDF]);
      expect(container.querySelector('li span')?.textContent).toBe('EXE');
      expect(container.textContent).toContain(
        'This file is a Windows executable, but its extension is .pdf.',
      );
      const chip = button('Download invoice.pdf, 72 B');
      const notes = document.getElementById(chip.getAttribute('aria-describedby') ?? '');
      expect(notes?.textContent).toBe(
        'This file is a Windows executable, but its extension is .pdf.',
      );
    });

    it('downloads only once the person has read the note and agreed', async () => {
      render([PROGRAM_AS_PDF]);
      await act(async () => button('Download invoice.pdf, 72 B').click());
      expect(made).toEqual([]);
      expect(dialog()?.textContent).toContain('Download invoice.pdf?');
      expect(dialog()?.textContent).toContain(
        'This file is a Windows executable, but its extension is .pdf.',
      );

      const confirm = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
        each => each.textContent === 'Download',
      );
      await act(async () => confirm?.click());
      await vi.waitFor(() =>
        expect(made).toEqual([{ url: 'blob:test/0', type: 'application/octet-stream' }]),
      );
      // The save's URL is revoked on a timer; waiting keeps it out of the next test.
      await vi.waitFor(() => expect(revoked).toEqual(['blob:test/0']));
    });

    it('saves nothing when the person cancels', async () => {
      render([PROGRAM_AS_PDF]);
      await act(async () => button('Download invoice.pdf, 72 B').click());
      const cancel = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
        each => each.textContent === 'Cancel',
      );
      await act(async () => cancel?.click());
      await vi.waitFor(() => expect(dialog()).toBeNull());
      expect(made).toEqual([]);
    });

    it('asks from the viewer too', async () => {
      render([PNG, PROGRAM_AS_PDF]);
      act(() => button('Preview chart.png, 12 B').click());
      act(() => button('Next attachment').click());
      await act(async () => button('Download invoice.pdf').click());
      expect(dialog()?.textContent).toContain(
        'This file is a Windows executable, but its extension is .pdf.',
      );
      expect(made.filter(({ type }) => type === 'application/octet-stream')).toEqual([]);
    });

    const renderStored = (stored: Attachment, bytes: Uint8Array<ArrayBuffer>) => {
      root = createRoot(container);
      act(() =>
        root?.render(<AttachmentList attachments={[stored]} loadFile={async () => bytes} />),
      );
    };

    it('asks about a stored file once its bytes are fetched, and saves nothing before', async () => {
      renderStored(
        { name: 'setup.exe', size: 3, kind: 'other', fileId: 'file-2' },
        new Uint8Array([1, 2, 3]),
      );
      await act(async () => button('Download setup.exe, 3 B').click());
      expect(dialog()?.textContent).toContain(
        'The .exe extension identifies a Windows executable, which may run when opened.',
      );
      expect(made).toEqual([]);
    });

    it('judges a forwarded file on its fetched bytes, not on the name its chip showed', async () => {
      const forwarded: Attachment = {
        name: 'invoice.pdf',
        size: 72,
        kind: 'pdf',
        mimeType: 'application/pdf',
        fileId: 'file-3',
      };
      renderStored(forwarded, PROGRAM_AS_PDF.content as Uint8Array<ArrayBuffer>);
      // Nothing to say before the bytes are here.
      expect(container.textContent).not.toContain('Windows executable');
      await act(async () => button('Download invoice.pdf, 72 B').click());
      expect(dialog()?.textContent).toContain(
        'This file is a Windows executable, but its extension is .pdf.',
      );
      expect(made).toEqual([]);
    });

    it('never previews a real PDF that has notes, so it opens only through the question', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      render([{ ...PDF, name: 'receipt.pdf.exe' }]);
      expect(labels()).toEqual(['Download receipt.pdf.exe, 9 B']);
      await act(async () => button('Download receipt.pdf.exe, 9 B').click());
      expect(open).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain('Download receipt.pdf.exe?');
      expect(made).toEqual([]);
    });
  });

  it('downloads a file with no notes at once', async () => {
    const dialog = () => document.querySelector('[role="alertdialog"]');
    render([
      HTML_AS_PDF,
      { ...PDF, name: 'archive.zip', kind: 'archive', mimeType: 'application/zip' },
    ]);
    await act(async () => button('Download archive.zip, 9 B').click());
    expect(dialog()).toBeNull();
    expect(made).toEqual([{ url: 'blob:test/0', type: 'application/octet-stream' }]);
    await vi.waitFor(() => expect(revoked).toEqual(['blob:test/0']));
  });

  it('shows a text file as text, never as markup', () => {
    render([TEXT]);
    act(() => button('Preview notes.txt, 40 B').click());
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toBe('<b id="pwn">bold?</b><script>window.ran = 1</script>');
    expect(pre?.children).toHaveLength(0);
    expect(document.getElementById('pwn')).toBeNull();
    expect(made).toEqual([]);
  });

  it('gives an image a URL typed by its bytes, and revokes it on close', async () => {
    render([PNG, TEXT]);
    act(() => button('Preview chart.png, 12 B').click());
    expect(made).toEqual([{ url: 'blob:test/0', type: 'image/png' }]);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:test/0');

    // Stepping away revokes it as surely as closing does.
    act(() => button('Next attachment').click());
    expect(revoked).toEqual(['blob:test/0']);
    act(() => button('Previous attachment').click());
    await act(async () => button('Close preview').click());
    await vi.waitFor(() => expect(revoked).toEqual(['blob:test/0', 'blob:test/1']));
    expect(document.querySelector('img')).toBeNull();
  });

  it('keeps the arrows working at both ends of the run, focus on the end button', () => {
    render([PNG, TEXT, PDF]);
    act(() => button('Preview chart.png, 12 B').click());
    const title = () => document.querySelector('[role="dialog"] h2')?.textContent;
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    for (const [name, back, end, stepped] of [
      ['Next attachment', 'ArrowLeft', 'receipt.pdf', 'notes.txt'],
      ['Previous attachment', 'ArrowRight', 'chart.png', 'notes.txt'],
    ] as const) {
      const arrow = button(name);
      act(() => arrow.focus());
      act(() => arrow.click());
      act(() => arrow.click());
      expect(title()).toBe(end);
      // `aria-disabled`, not disabled: a disabled button drops focus out of the dialog in Firefox.
      expect(arrow.disabled).toBe(false);
      expect(arrow.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(arrow);
      press(back);
      expect(title()).toBe(stepped);
    }
  });

  it('offers no download for an attachment whose bytes it does not have', () => {
    render([PNG, { name: 'originals.zip', size: 9, kind: 'archive' }]);
    act(() => button('Preview chart.png, 12 B').click());
    act(() => button('Next attachment').click());
    expect(button('Download originals.zip').disabled).toBe(true);
    const notice = Array.from(document.querySelectorAll('[role="dialog"] button')).find(
      each => each.textContent === 'Download',
    );
    expect(notice?.hasAttribute('disabled')).toBe(true);
  });

  it('opens a PDF in a new tab under its own type, and revokes it when the message goes', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render([PDF]);
    act(() => button('Open receipt.pdf in a new tab, 9 B').click());
    act(() => button('Open receipt.pdf in a new tab, 9 B').click());
    expect(made).toEqual([{ url: 'blob:test/0', type: 'application/pdf' }]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('blob:test/0', '_blank', 'noopener');
    expect(revoked).toEqual([]);
    act(() => root?.unmount());
    root = null;
    expect(revoked).toEqual(['blob:test/0']);
  });
});
