// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import { clearCachedFrames } from './frame-cache';
import { HtmlBody } from './HtmlBody';
import { IMAGE_CONSENTS_RECORD_TYPE, IMAGE_SENDER_RECORD_TYPE } from './remote-images';
import { RemoteImagesStoreProvider } from './remote-images-context';

const problems = vi.hoisted(() => [] as { title: string; description: string }[]);
vi.mock('../ui/Toast', () => ({
  reportProblem: (title: string, description: string) => problems.push({ title, description }),
}));

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

/** The reader as it sits in the app: under the remembered answers, here over `store` or memory. */
const Reader = ({
  store = null,
  ...props
}: Partial<ComponentProps<typeof HtmlBody>> & { store?: RecordStore | null }) => (
  <RemoteImagesStoreProvider store={store}>
    <HtmlBody
      html=""
      messageId="mid/<m1@sender.example>"
      fromName="Sender"
      fromAddress="news@sender.example"
      senderCheck={undefined}
      inlineImagesTruncated={false}
      fallback={null}
      {...props}
    />
  </RemoteImagesStoreProvider>
);

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
});

const mountWithheld = async (html: string, props: ComponentProps<typeof Reader> = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Reader html={html} {...props} />));
  const frameWindow = container.querySelector('iframe')?.contentWindow;
  if (frameWindow === null || frameWindow === undefined) throw new Error('iframe did not mount');
  const clickImage = (source: Window = frameWindow) =>
    act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', { source, data: { type: 'yozz:load-remote-images' } }),
      ),
    );
  const srcdoc = () => container.querySelector('iframe')?.srcdoc ?? '';
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(candidate =>
      candidate.textContent?.startsWith(text),
    );
  const dialogButton = (text: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(
      button => button.textContent === text,
    );
  return { container, root, clickImage, srcdoc, button, dialogButton };
};

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
        <Reader
          key="first-message"
          html={first}
          messageId="mid/<first@first.example>"
          fromName="First"
          fromAddress="first@first.example"
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
    if (firstFrame === null || firstWindow === null || firstWindow === undefined) {
      throw new Error('first iframe did not mount');
    }
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
        <Reader
          key="second-message"
          html={second}
          messageId="mid/<second@second.example>"
          fromName="Second"
          fromAddress="second@second.example"
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
      root.render(<Reader html={html} fromName="Many CDNs" fallback={<p>fallback</p>} />),
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
        <Reader
          html="__unsupported__"
          fromName="Unsupported"
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
        <Reader
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
  it('builds a withheld frame once per HTML, and loses it on lock', async () => {
    const html = '<p>kept</p><img src="https://cdn.example/kept.png">';
    const first = await mountWithheld(html);
    const withheld = first.srcdoc();
    await act(async () => roots.pop()?.unmount());
    first.container.remove();

    // Another message with the same bytes: the frame is a function of them alone.
    const twin = await mountWithheld(html, { messageId: 'mid/<twin@sender.example>' });
    // Byte-identical, nonce included: the sanitiser did not run again.
    expect(twin.srcdoc()).toBe(withheld);
    twin.container.remove();

    clearCachedFrames();
    const afterLock = await mountWithheld(html);
    expect(afterLock.srcdoc()).not.toBe(withheld);
    afterLock.container.remove();
  });
});

describe('HtmlBody remembered consent', () => {
  const html = '<img src="https://cdn.example/hero.png" width="600" height="200">';
  const loaded = (srcdoc: string) => srcdoc.includes('https://cdn.example/hero.png');
  /** Lets the provider's vault reads and the consent's background write settle. */
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

  it('loads a consented message again on the next open, on any device, and on no other message', async () => {
    const { store, rows, key } = fakeRecordStore();
    const first = await mountWithheld(html, { store });
    await settle();
    await act(async () => first.button('Load remote images')?.click());
    await settle();
    expect(loaded(first.srcdoc())).toBe(true);
    expect(rows.get(key(IMAGE_CONSENTS_RECORD_TYPE, 'consents'))?.plaintext).toContain(
      'mid/<m1@sender.example>',
    );
    first.container.remove();

    // A fresh provider over the same vault is a reload, or the phone.
    const reopened = await mountWithheld(html, { store });
    await settle();
    expect(loaded(reopened.srcdoc())).toBe(true);
    expect(reopened.button('Load remote images')).toBeUndefined();
    reopened.container.remove();

    // The same Message-ID under another From is another message.
    const impostor = await mountWithheld(html, { store, fromAddress: 'someone@else.example' });
    await settle();
    expect(loaded(impostor.srcdoc())).toBe(false);
    impostor.container.remove();
  });

  it('offers nothing until the remembered answers are read', async () => {
    const { store } = fakeRecordStore();
    const vault = Promise.withResolvers<void>();
    const slow: RecordStore = {
      ...store,
      get: async (...args) => {
        await vault.promise;
        return store.get(...args);
      },
    };
    const reader = await mountWithheld(html, { store: slow });
    await settle();
    expect(reader.button('Load remote images')).toBeUndefined();
    vault.resolve();
    await settle();
    expect(reader.button('Load remote images')).toBeDefined();
    reader.container.remove();
  });

  const VERIFIED = { status: 'verified' } as const;
  const FAILED = { status: 'failed' } as const;
  const UNCHECKED = { status: 'unchecked', imapHost: 'imap.example.org' } as const;
  const senderRecord = (rows: Map<string, { plaintext: string }>, id: string) =>
    JSON.parse(rows.get(id)?.plaintext ?? 'null');
  const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? '';

  it('trusts a verified sender in one click, for their verified mail only', async () => {
    const { store, rows, key } = fakeRecordStore();
    const unknown = await mountWithheld(html, { store });
    await settle();
    // Nothing known about this From: nothing to offer.
    expect(unknown.button('Always from')).toBeUndefined();
    unknown.container.remove();

    const verified = await mountWithheld(html, { store, senderCheck: VERIFIED });
    await settle();
    await act(async () => verified.button('Always from news@sender.example')?.click());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(senderRecord(rows, key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toMatchObject({
      address: 'news@sender.example',
      isVerifiedOnly: true,
    });
    expect(loaded(verified.srcdoc())).toBe(true);
    expect(verified.container.textContent).toContain(
      'Images from news@sender.example always load.',
    );
    verified.container.remove();

    // Another verified message from that sender loads unasked, whatever the case.
    const next = await mountWithheld(html, {
      store,
      messageId: 'mid/<m2@sender.example>',
      fromAddress: 'News@Sender.Example',
      senderCheck: VERIFIED,
    });
    await settle();
    expect(loaded(next.srcdoc())).toBe(true);
    next.container.remove();

    // The same address unverified could be a forgery: it asks, and "always" goes through the warning.
    const forged = await mountWithheld(html, {
      store,
      messageId: 'mid/<m3@sender.example>',
      senderCheck: FAILED,
    });
    await settle();
    expect(loaded(forged.srcdoc())).toBe(false);
    expect(forged.button('Load remote images')).toBeDefined();
    await act(async () => forged.button('Always from news@sender.example')?.click());
    expect(dialogText()).toContain('This message may be forged');
    forged.container.remove();
  });

  it('warns before trusting a sender whose message did not pass, and Cancel trusts nobody', async () => {
    const { store, rows, key } = fakeRecordStore();
    const reader = await mountWithheld(html, { store, senderCheck: FAILED });
    await settle();
    await act(async () => reader.button('Always from news@sender.example')?.click());
    expect(dialogText()).toContain('This message may be forged');
    expect(dialogText()).toContain('It failed sender verification.');
    expect(dialogText()).toContain('Fakes from this address would load images too.');
    // The safer answer is not outshone by the risky one.
    expect(reader.dialogButton('Always load')?.className).not.toContain('bg-signal');
    await act(async () => reader.dialogButton('Cancel')?.click());
    await settle();
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(false);
    expect(loaded(reader.srcdoc())).toBe(false);

    await act(async () => reader.button('Always from news@sender.example')?.click());
    await act(async () => reader.dialogButton('Always load')?.click());
    await settle();
    expect(senderRecord(rows, key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toMatchObject({
      isVerifiedOnly: false,
    });
    expect(loaded(reader.srcdoc())).toBe(true);
    expect(reader.container.textContent).toContain(
      'Images from news@sender.example always load, verified or not.',
    );
    reader.container.remove();

    // Every message showing that From now loads, verified or not.
    for (const senderCheck of [VERIFIED, UNCHECKED, FAILED]) {
      const next = await mountWithheld(html, {
        store,
        messageId: `mid/<${senderCheck.status}@sender.example>`,
        senderCheck,
      });
      await settle();
      expect(loaded(next.srcdoc())).toBe(true);
      next.container.remove();
    }
  });

  it('keeps the warning open with the reason when the save fails, and saves on a retry', async () => {
    const { store, rows, key } = fakeRecordStore();
    let isOffline = true;
    const flaky: RecordStore = {
      ...store,
      put: async input => {
        if (isOffline && input.type === IMAGE_SENDER_RECORD_TYPE) {
          throw new TypeError('Failed to fetch');
        }
        return store.put(input);
      },
    };
    const reader = await mountWithheld(html, { store: flaky, senderCheck: FAILED });
    await settle();
    problems.length = 0;
    await act(async () => reader.button('Always from news@sender.example')?.click());
    await act(async () => reader.dialogButton('Always load')?.click());
    await settle();
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
      'Sender not saved.',
    );
    // Said where the person is looking, not again in a toast.
    expect(problems).toEqual([]);
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(false);
    expect(loaded(reader.srcdoc())).toBe(false);

    isOffline = false;
    await act(async () => reader.dialogButton('Always load')?.click());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(true);
    expect(loaded(reader.srcdoc())).toBe(true);
    reader.container.remove();
  });

  it("names the provider it can't check senders on, and asks with a plain decision", async () => {
    const reader = await mountWithheld(html, { senderCheck: UNCHECKED });
    await act(async () => reader.button('Always from news@sender.example')?.click());
    expect(dialogText()).toContain('Always load images from news@sender.example?');
    expect(dialogText()).toContain("YOZZ can't verify senders on imap.example.org.");
    expect(dialogText()).not.toContain('forged');
    expect(reader.dialogButton('Always load')?.className).toContain('bg-signal');
    await act(async () => reader.dialogButton('Cancel')?.click());
    reader.container.remove();
  });

  it('widens a verified-only trust given again through the warning', async () => {
    const { store, rows, key } = fakeRecordStore();
    rows.set(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'), {
      // A record from before the warning existed: verified-only.
      plaintext: JSON.stringify({ address: 'news@sender.example', addedAt: 1 }),
      revision: 1,
    });
    const reader = await mountWithheld(html, { store, senderCheck: UNCHECKED });
    await settle();
    expect(loaded(reader.srcdoc())).toBe(false);
    await act(async () => reader.button('Always from news@sender.example')?.click());
    await act(async () => reader.dialogButton('Always load')?.click());
    await settle();
    expect(senderRecord(rows, key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toMatchObject({
      isVerifiedOnly: false,
    });
    expect(loaded(reader.srcdoc())).toBe(true);
    reader.container.remove();
  });

  it('still offers "always" once a message is loaded by hand, and not once the sender is trusted', async () => {
    const { store, rows, key } = fakeRecordStore();
    const reader = await mountWithheld(html, { store, senderCheck: VERIFIED });
    await settle();
    await act(async () => reader.button('Load remote images')?.click());
    await settle();
    expect(loaded(reader.srcdoc())).toBe(true);
    expect(reader.button('Load remote images')).toBeUndefined();
    expect(reader.container.textContent).toContain('Just this message.');
    await act(async () => reader.button('Always from news@sender.example')?.click());
    await settle();
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(true);
    expect(reader.container.textContent).not.toContain('Just this message.');
    expect(reader.button('Always from')).toBeUndefined();
    expect(reader.button('Stop')).toBeDefined();
    reader.container.remove();

    // Unverified, the offer after loading goes through the same warning.
    const unverified = await mountWithheld(html, {
      store,
      fromAddress: 'other@sender.example',
      senderCheck: FAILED,
    });
    await settle();
    await act(async () => unverified.button('Load remote images')?.click());
    await settle();
    await act(async () => unverified.button('Always from other@sender.example')?.click());
    expect(dialogText()).toContain('This message may be forged');
    await act(async () => unverified.dialogButton('Cancel')?.click());
    unverified.container.remove();
  });

  it('draws Stop as a button, not as a word in the sentence', async () => {
    const reader = await mountWithheld(html, { senderCheck: VERIFIED });
    await act(async () => reader.button('Always from news@sender.example')?.click());
    expect(reader.button('Stop')?.className).toContain('bg-ink-hover');
    reader.container.remove();
  });

  it('stops trusting a sender from the message it loaded, and blocks that message in place', async () => {
    const { store, rows, key } = fakeRecordStore();
    // Trusted from this message ("Always from" loads it too); another of theirs was loaded by hand.
    const reader = await mountWithheld(html, {
      store,
      messageId: 'mid/<m4@sender.example>',
      senderCheck: VERIFIED,
    });
    await settle();
    await act(async () => reader.button('Always from news@sender.example')?.click());
    await settle();
    const other = await mountWithheld(html, { store, messageId: 'mid/<m5@sender.example>' });
    await settle();
    await act(async () => other.button('Load remote images')?.click());
    await settle();
    other.container.remove();
    expect(loaded(reader.srcdoc())).toBe(true);

    await act(async () => reader.button('Stop')?.click());
    await settle();
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(false);
    expect(loaded(reader.srcdoc())).toBe(false);
    expect(reader.button('Load remote images')).toBeDefined();
    expect(reader.button('Always from news@sender.example')).toBeDefined();
    const stored = rows.get(key(IMAGE_CONSENTS_RECORD_TYPE, 'consents'))?.plaintext ?? '';
    expect(stored).not.toContain('mid/<m4@sender.example>');
    expect(stored).toContain('mid/<m5@sender.example>');
    reader.container.remove();
  });

  it('says the sender was removed when only forgetting this message failed', async () => {
    const { store, rows, key } = fakeRecordStore();
    rows.set(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'), {
      plaintext: JSON.stringify({ address: 'news@sender.example', addedAt: 1 }),
      revision: 1,
    });
    const refusingConsents: RecordStore = {
      ...store,
      put: async input => {
        if (input.type === IMAGE_CONSENTS_RECORD_TYPE) throw new TypeError('Failed to fetch');
        return store.put(input);
      },
    };
    const reader = await mountWithheld(html, {
      store: refusingConsents,
      messageId: 'mid/<m6@sender.example>',
      senderCheck: VERIFIED,
    });
    await settle();
    problems.length = 0;
    await act(async () => reader.button('Stop')?.click());
    await settle();
    expect(rows.has(key(IMAGE_SENDER_RECORD_TYPE, 'news@sender.example'))).toBe(false);
    expect(problems.map(problem => problem.title)).toEqual(['Sender removed']);
    expect(loaded(reader.srcdoc())).toBe(false);
    reader.container.remove();
  });
});
