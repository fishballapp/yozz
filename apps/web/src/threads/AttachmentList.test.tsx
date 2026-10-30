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
    expect(tags).toEqual(['IMG', 'TXT', 'PDF', 'ZIP']);
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
