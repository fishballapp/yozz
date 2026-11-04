// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServedMail } from './frame-scripts.ts';
import { MAIL_FRAME_MEASURE_SCRIPT, SERVED_MAIL_DATA_ID } from './frame-scripts.ts';

const SECRET_WORD = 'raw-mail-marker';

const mount = async (data: ServedMail | string) => {
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = SERVED_MAIL_DATA_ID;
  block.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  document.body.replaceChildren(block);
  document.documentElement.style.cssText = '';
  vi.resetModules();
  await import('./served-mail.ts');
};

const frameOf = () => {
  const frame = document.querySelector('iframe');
  if (frame === null) throw new Error('no frame mounted');
  return frame;
};

describe('the served mail page', () => {
  beforeEach(() => {
    vi.doUnmock('./html.ts');
  });

  it("mounts a frame sandboxed as yozz.app's, with only the measuring script", async () => {
    await mount({ html: '<p>hello</p>', allowRemoteImages: false });
    const frame = frameOf();
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-popups allow-popups-to-escape-sandbox',
    );
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.title).toBe('Mail');
    expect(frame.srcdoc).toContain('<p>hello</p>');
    expect(frame.srcdoc).toContain(MAIL_FRAME_MEASURE_SCRIPT);
    expect(frame.srcdoc).not.toContain('yozz:load-remote-images');
  });

  it('applies the remote-image choice the page carries', async () => {
    const html = '<img src="https://t.example/a.png" width="600" height="300">';
    await mount({ html, allowRemoteImages: false });
    expect(frameOf().srcdoc).not.toContain('t.example');
    await mount({ html, allowRemoteImages: true });
    expect(frameOf().srcdoc).toContain('src="https://t.example/a.png"');
  });

  it('has the ground its mail has', async () => {
    await mount({ html: '<p>no colours</p>', allowRemoteImages: false });
    expect(document.documentElement.style.background).toBe('');
    await mount({ html: '<p style="color:#111">colours</p>', allowRemoteImages: false });
    expect(document.documentElement.style.background).toBe('rgb(255, 255, 255)');
  });

  it('takes a height only from its own frame, and clamps it', async () => {
    await mount({ html: '<p>hello</p>', allowRemoteImages: false });
    const frame = frameOf();
    const post = (data: unknown, source: MessageEventSource | null) =>
      dispatchEvent(new MessageEvent('message', { data, source }));
    const type = 'yozz:mail-height';

    post({ type, height: 500 }, null);
    post({ type, height: 500 }, window);
    expect(frame.style.height).toBe('160px');

    const source = frame.contentWindow;
    post({ type, height: 500.5 }, source);
    expect(frame.style.height).toBe('501px');

    for (const height of [-1, Number.NaN, Number.POSITIVE_INFINITY, '700', null]) {
      post({ type, height }, source);
      expect(frame.style.height).toBe('501px');
    }
    post({ type: 'other', height: 700 }, source);
    expect(frame.style.height).toBe('501px');

    post({ type, height: 1e12 }, source);
    expect(frame.style.height).toBe('200000px');
  });

  it('fails closed with a fixed message when the sanitiser throws', async () => {
    vi.doMock('./html.ts', () => ({
      buildMailFrame: () => {
        throw new Error('no CSS parser');
      },
    }));
    await mount({ html: `<p>${SECRET_WORD}</p>`, allowRemoteImages: false });
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.body.textContent).toBe('This mail could not be shown.');
    expect(document.body.innerHTML).not.toContain(SECRET_WORD);
  });

  it('fails closed on a data block that holds no mail', async () => {
    await mount('{"html":1}');
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.body.textContent).toBe('This mail could not be shown.');
    await mount('not json');
    expect(document.body.textContent).toBe('This mail could not be shown.');
  });
});
