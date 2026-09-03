// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlBody } from './HtmlBody';

vi.mock('./html', async importOriginal => {
  const actual = await importOriginal<typeof import('./html')>();
  return {
    ...actual,
    buildMailFrame: (...args: Parameters<typeof actual.buildMailFrame>) => {
      if (args[0] === '__unsupported__') throw new Error('unsupported');
      return actual.buildMailFrame(...args);
    },
  };
});

// This jsdom exposes no `localStorage`; the "don't ask again" preference needs one to land in.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
});

describe('HtmlBody remote-image consent', () => {
  it('belongs to the exact message and is not inherited by the next sender', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const first = '<img src="https://first.example/pixel.gif">';
    const second = '<img src="https://second.example/pixel.gif">';

    await act(async () =>
      root.render(
        <HtmlBody
          key="first-message"
          html={first}
          fromName="First"
          inlineImagesTruncated={false}
          fallback={<p>first fallback</p>}
        />,
      ),
    );
    const button = container.querySelector('button');
    expect(button?.textContent).toContain('Load remote images');
    await act(async () => button?.click());
    expect(container.querySelector('iframe')?.srcdoc).toContain('first.example');
    const firstFrame = container.querySelector('iframe');
    const firstWindow = firstFrame?.contentWindow;
    if (firstFrame === null || firstWindow === null || firstWindow === undefined)
      throw new Error('first iframe did not mount');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: firstWindow,
          data: { type: 'yozz:mail-height', height: 8000 },
        }),
      ),
    );
    expect(firstFrame.style.height).toBe('8000px');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: firstWindow,
          data: { type: 'yozz:mail-height', height: Number.NaN },
        }),
      ),
    );
    expect(firstFrame.style.height).toBe('8000px');

    await act(async () =>
      root.render(
        <HtmlBody
          key="second-message"
          html={second}
          fromName="Second"
          inlineImagesTruncated={false}
          fallback={<p>second fallback</p>}
        />,
      ),
    );
    const secondFrame = container.querySelector('iframe');
    expect(secondFrame).not.toBe(firstFrame);
    expect(secondFrame?.style.height).toBe('160px');
    expect(secondFrame?.srcdoc).not.toContain('second.example');
    expect(container.querySelector('button')?.textContent).toContain('Load remote images');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: firstWindow,
          data: { type: 'yozz:mail-height', height: 9000 },
        }),
      ),
    );
    expect(secondFrame?.style.height).toBe('160px');
    container.remove();
  });

  const mountWithheld = async (html: string) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <HtmlBody html={html} fromName="Sender" inlineImagesTruncated={false} fallback={null} />,
      ),
    );
    const frameWindow = container.querySelector('iframe')?.contentWindow;
    if (frameWindow === null || frameWindow === undefined) throw new Error('iframe did not mount');
    const clickImage = (source: Window = frameWindow) =>
      act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', { source, data: { type: 'yozz:load-remote-images' } }),
        ),
      );
    const srcdoc = () => container.querySelector('iframe')?.srcdoc ?? '';
    const dialogButton = (text: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(
        button => button.textContent === text,
      );
    return { container, clickImage, srcdoc, dialogButton };
  };

  it('asks before an image click loads pictures, and remembers "don\'t ask again"', async () => {
    localStorage.removeItem('yozz:ask-before-remote-images');
    const html = '<img src="https://cdn.example/hero.png" width="600" height="200">';
    const first = await mountWithheld(html);

    // A stranger's window on the same channel does nothing.
    await first.clickImage(window);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await first.clickImage();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Show remote images?',
    );
    expect(first.srcdoc()).not.toContain('cdn.example');
    await act(async () => first.dialogButton('Cancel')?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(first.srcdoc()).not.toContain('cdn.example');

    await first.clickImage();
    const checkbox = document.querySelector<HTMLInputElement>('[role="alertdialog"] input');
    await act(async () => checkbox?.click());
    await act(async () => first.dialogButton('Show images')?.click());
    expect(first.srcdoc()).toContain('https://cdn.example/hero.png');
    expect(first.container.querySelector('button')).toBeNull();
    expect(localStorage.getItem('yozz:ask-before-remote-images')).toBe('false');
    first.container.remove();

    const second = await mountWithheld(html);
    await second.clickImage();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(second.srcdoc()).toContain('https://cdn.example/hero.png');
    second.container.remove();
    localStorage.removeItem('yozz:ask-before-remote-images');
  });

  it('tells the reader when the remote-origin ceiling removed images', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const html = Array.from(
      { length: 65 },
      (_, index) => `<img src="https://images-${index}.example/pixel.gif">`,
    ).join('');

    await act(async () =>
      root.render(
        <HtmlBody
          html={html}
          fromName="Many CDNs"
          inlineImagesTruncated={false}
          fallback={<p>fallback</p>}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Some remote images were blocked.');
    container.remove();
  });

  it('shows the text fallback when safe frame construction is unavailable', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () =>
      root.render(
        <HtmlBody
          html="__unsupported__"
          fromName="Unsupported"
          inlineImagesTruncated={false}
          fallback={<p>Readable fallback</p>}
        />,
      ),
    );

    expect(container.textContent).toBe('Readable fallback');
    expect(container.querySelector('iframe')).toBeNull();
    container.remove();
  });

  it('tells the reader when CID allocation ceilings removed inline images', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () =>
      root.render(
        <HtmlBody
          html="<p>Message</p>"
          fromName="Inline images"
          inlineImagesTruncated
          fallback={<p>fallback</p>}
        />,
      ),
    );

    expect(container.textContent).toContain('Some inline images were blocked.');
    container.remove();
  });
});
