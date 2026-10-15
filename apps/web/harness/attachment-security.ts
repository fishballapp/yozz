/**
 * The attachment half of `html:security`. A `blob:` URL carries yozz.app's origin, so a blob that
 * became a document with script would reach the vault's keys in IndexedDB. This proves, per engine,
 * that the real policy refuses what lies about itself, that the real chips render and revoke what
 * they should, and that each type the app ever gives a blob stays inert in the browser even when
 * its bytes are hostile.
 */
import { crc32, deflateSync } from 'node:zlib';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { formatBytes } from '../src/threads/attachments.ts';
import type { AttachmentHarness, ProbeFile } from './attachment-security-page';

const CHANNEL = 'yozz-attachment-probe';
const HOSTILE_HTML = `<!doctype html><div id="pwn">pwn</div><script>new BroadcastChannel('${CHANNEL}').postMessage('html')</script>`;
const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><rect id="pwn" width="1" height="1"/><script>new BroadcastChannel('${CHANNEL}').postMessage('svg')</script></svg>`;
const POLYGLOT_PDF = `%PDF-1.4\n${HOSTILE_HTML}`;
const RLO_NAME = 'invoice\u202efdp.exe';
const POPUP_TIMEOUT_MS = 10_000;

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** A real 2×2 RGB PNG, so the image check proves a decode and not just a request. */
const png = (): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** A one-page PDF with a correct cross-reference table, so every viewer opens it without repair. */
const pdf = (): string => {
  const stream = 'BT /F1 24 Tf 20 100 Td (Receipt) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const { body, offsets } = objects.reduce(
    (acc, object, index) => ({
      body: `${acc.body}${index + 1} 0 obj\n${object}\nendobj\n`,
      offsets: [...acc.offsets, acc.body.length],
    }),
    { body: '%PDF-1.4\n', offsets: [] as number[] },
  );
  const xref = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
};

const file = (name: string, mimeType: string, content: string | Buffer): ProbeFile => ({
  name,
  mimeType,
  base64: Buffer.from(content).toString('base64'),
});

const PNG_BYTES = png();
const PDF_TEXT = pdf();
const PNG_FILE = file('pixel.png', 'image/png', PNG_BYTES);
const TEXT_FILE = file('notes.txt', 'text/plain', HOSTILE_HTML);
const PDF_FILE = file('receipt.pdf', 'application/pdf', PDF_TEXT);
const POLYGLOT_FILE = file('polyglot.pdf', 'application/pdf', POLYGLOT_PDF);
const HTML_AS_PDF = file('statement.pdf', 'application/pdf', HOSTILE_HTML);
const HTML_AS_PNG = file('photo.png', 'image/png', HOSTILE_HTML);
const SVG_FILE = file('logo.svg', 'image/svg+xml', HOSTILE_SVG);
const SVG_AS_PNG = file('logo.png', 'image/png', HOSTILE_SVG);
const HTML_FILE = file('page.html', 'text/html', HOSTILE_HTML);
const RLO_FILE = file(RLO_NAME, 'application/octet-stream', 'MZ');
// Under a generic label the extension makes the claim, and the bytes must still agree with it.
const GENERIC_PNG = file('scan.png', 'application/octet-stream', PNG_BYTES);
const GENERIC_PDF = file('receipt.pdf', 'application/octet-stream', PDF_TEXT);
const GENERIC_HTML_AS_PNG = file('photo.png', 'application/octet-stream', HOSTILE_HTML);
const GENERIC_HTML_AS_PDF = file('statement.pdf', 'application/octet-stream', HOSTILE_HTML);
const GENERIC_SVG = file('logo.svg', 'application/octet-stream', HOSTILE_SVG);

/** What the real policy must answer for each file: the hostile ones are downloads only. */
const POLICY: readonly (readonly [ProbeFile, string | null])[] = [
  [PNG_FILE, 'image'],
  [TEXT_FILE, 'text'],
  [PDF_FILE, 'pdf'],
  [POLYGLOT_FILE, 'pdf'],
  [HTML_AS_PDF, null],
  [HTML_AS_PNG, null],
  [SVG_FILE, null],
  [SVG_AS_PNG, null],
  [HTML_FILE, null],
  [RLO_FILE, null],
  [GENERIC_PNG, 'image'],
  [GENERIC_PDF, 'pdf'],
  [GENERIC_HTML_AS_PNG, null],
  [GENERIC_HTML_AS_PDF, null],
  [GENERIC_SVG, null],
];

type HarnessWindow = typeof globalThis & {
  attachmentSecurity?: AttachmentHarness;
  probeMessages?: unknown[];
  revokedUrls?: string[];
  openedUrls?: string[];
};

/** A document is inert here when the attachment's markup was never parsed into it. */
const describeDocument = (page: Page) =>
  page.evaluate(() => ({
    contentType: document.contentType,
    isParsed: document.getElementById('pwn') !== null,
  }));

/**
 * The app revoked the URL, read from the calls it made. The browser cannot say so itself: the host
 * CSP's `connect-src` refuses `fetch` of any `blob:` URL, revoked or not, and Firefox's image cache
 * still draws a revoked image URL it has already decoded.
 */
const assertRevoked = async (page: Page, url: string, message: string) => {
  const revoked = await page.evaluate(() => (globalThis as HarnessWindow).revokedUrls ?? []);
  assert(revoked.includes(url), message);
};

/**
 * The one engine allowed to save a PDF instead of showing it: Playwright's WebKit for Linux ships no
 * PDF viewer (its macOS build has one). Only for PDF, and only there; anywhere else a save fails.
 */
const savesPdf = (label: string) => label === 'WebKit' && process.platform === 'linux';

/**
 * `open` saved the file. The tab `window.open` made may stay behind (Linux WebKit keeps it), but only
 * as the empty page it began as: nothing of the file reached a document.
 */
const assertSaved = async (
  context: BrowserContext,
  page: Page,
  open: () => Promise<void>,
  what: string,
) => {
  const [saved] = await Promise.all([
    page.waitForEvent('download', { timeout: POPUP_TIMEOUT_MS }),
    open(),
  ]);
  assert((await saved.failure()) === null, `${what} began saving and failed`);
  for (const tab of context.pages().filter(each => each !== page)) {
    const left = await tab.evaluate(() => ({
      url: location.href,
      isEmpty: document.body === null || document.body.childNodes.length === 0,
    }));
    assert(
      ['', 'about:blank'].includes(left.url) && left.isEmpty,
      `${what} was saved but also left a tab showing ${JSON.stringify(left)}`,
    );
    await tab.close();
  }
};

/**
 * The tab `open` makes, loaded. Every engine here is configured to show a PDF in its own viewer, so
 * an engine that saves instead fails the gate rather than skipping the checks that need the tab.
 */
const openedTab = async (
  context: BrowserContext,
  page: Page,
  open: () => Promise<void>,
  what: string,
): Promise<Page> => {
  const popup = context.waitForEvent('page', { timeout: POPUP_TIMEOUT_MS });
  const download = page.waitForEvent('download', { timeout: POPUP_TIMEOUT_MS });
  await open();
  const outcome = await Promise.race([popup, download.then(() => null)]);
  // The loser of the race times out on its own; nothing waits on it.
  popup.catch(() => undefined);
  download.catch(() => undefined);
  assert(outcome !== null, `${what} was saved instead of opened, so nothing it shows was checked`);
  await outcome.waitForLoadState('load');
  return outcome;
};

/** The viewer's position, from its counter (`Attachment 3 / of 7` to a screen reader). */
const viewerPosition = async (page: Page) =>
  Number(
    /\d+/.exec(
      (await page.locator('[role="dialog"] [aria-live="polite"]').textContent()) ?? '',
    )?.[0],
  );

/** Focus is still somewhere in the viewer, where its arrow keys are heard. */
const isFocusInViewer = (page: Page) =>
  page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));

export const runAttachmentChecks = async (
  label: string,
  browser: Browser,
  origin: string,
  csp: string,
) => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.route(`${origin}/harness/attachment-security.html`, async route => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': csp },
      });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/harness/attachment-security.html`);
    await page.waitForFunction(
      () => (globalThis as HarnessWindow).attachmentSecurity !== undefined,
    );
    // Same origin as every blob the app makes, so a payload that ran anywhere reports here. Every
    // URL the app revokes is recorded on its way to the real call.
    await page.evaluate(channel => {
      const target = globalThis as HarnessWindow;
      target.probeMessages = [];
      new BroadcastChannel(channel).onmessage = event => target.probeMessages?.push(event.data);
      const revokedUrls: string[] = [];
      target.revokedUrls = revokedUrls;
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => {
        revokedUrls.push(url);
        revoke(url);
      };
      // What the app hands `window.open`, so a PDF's URL is known even where the engine saves it.
      const openedUrls: string[] = [];
      target.openedUrls = openedUrls;
      const open = window.open.bind(window);
      window.open = (url, name, features) => {
        if (url !== undefined) openedUrls.push(String(url));
        return open(url, name, features);
      };
    }, CHANNEL);

    // The label and the bytes must agree before anything renders.
    const kinds = await page.evaluate(
      files =>
        files.map(each => (globalThis as HarnessWindow).attachmentSecurity?.previewKind(each)),
      POLICY.map(([each]) => each),
    );
    for (const [index, [each, expected]] of POLICY.entries())
      assert(
        kinds[index] === expected,
        `${label}: ${each.name} (${each.mimeType}) previewed as ${kinds[index]}, expected ${expected}`,
      );

    const mounted = [PNG_FILE, TEXT_FILE, PDF_FILE, POLYGLOT_FILE, HTML_AS_PDF, SVG_FILE, RLO_FILE];
    await page.evaluate(
      files => (globalThis as HarnessWindow).attachmentSecurity?.mount(files),
      mounted,
    );
    const chipLabels = await page
      .locator('#root button')
      .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
    const expectedLabels = [
      `Preview pixel.png, ${formatBytes(PNG_BYTES.length)}`,
      'Download pixel.png',
      `Preview notes.txt, ${formatBytes(HOSTILE_HTML.length)}`,
      'Download notes.txt',
      `Open receipt.pdf in a new tab, ${formatBytes(PDF_TEXT.length)}`,
      'Download receipt.pdf',
      `Open polyglot.pdf in a new tab, ${formatBytes(POLYGLOT_PDF.length)}`,
      'Download polyglot.pdf',
      `Download statement.pdf, ${formatBytes(HOSTILE_HTML.length)}`,
      `Download logo.svg, ${formatBytes(HOSTILE_SVG.length)}`,
      'Download invoicefdp.exe, 2 B',
    ];
    assert(
      JSON.stringify(chipLabels) === JSON.stringify(expectedLabels),
      `${label}: chips drifted: ${JSON.stringify(chipLabels)}`,
    );

    // U+202E would show `invoiceexe.pdf`; the chip and the saved file both show what it is.
    const rloChip = await page.locator('#root li').last().innerText();
    assert(
      !rloChip.includes('\u202e') && rloChip.includes('invoicefdp.exe'),
      `${label}: a bidi override survived in the chip: ${JSON.stringify(rloChip)}`,
    );
    const [saved] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download invoicefdp.exe, 2 B' }).click(),
    ]);
    assert(
      saved.suggestedFilename() === 'invoicefdp.exe',
      `${label}: download was named ${JSON.stringify(saved.suggestedFilename())}`,
    );
    // The `download` attribute is the guard: WebKit renders an `application/octet-stream` blob as
    // HTML when one is opened as a page, so a download must never become one.
    assert(context.pages().length === 1, `${label}: a download opened a tab`);

    // Text is a text node: the markup is on screen as characters and nowhere in the DOM.
    await page
      .getByRole('button', { name: `Preview notes.txt, ${formatBytes(HOSTILE_HTML.length)}` })
      .click();
    const shown = await page.locator('[role="dialog"] pre').textContent();
    assert(shown === HOSTILE_HTML, `${label}: text preview showed ${JSON.stringify(shown)}`);
    assert((await page.locator('#pwn').count()) === 0, `${label}: text preview parsed its markup`);
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

    // An image decodes from a blob typed by its bytes, and the URL dies with the preview.
    await page
      .getByRole('button', { name: `Preview pixel.png, ${formatBytes(PNG_BYTES.length)}` })
      .click();
    const image = page.locator('[role="dialog"] img');
    await image.waitFor();
    await page.waitForFunction(() => {
      const shown = document.querySelector('[role="dialog"] img');
      return shown instanceof HTMLImageElement && shown.naturalWidth === 2;
    });
    const imageUrl = await image.getAttribute('src');
    assert(imageUrl?.startsWith('blob:') === true, `${label}: image preview src was ${imageUrl}`);
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    await assertRevoked(page, imageUrl, `${label}: closing the preview left its image URL alive`);

    // Keyboard stepping holds at both ends: the end's arrow stays focused (natively disabled, Firefox
    // drops focus to `body`, outside the dialog), so the arrow keys still step.
    await page
      .getByRole('button', { name: `Preview pixel.png, ${formatBytes(PNG_BYTES.length)}` })
      .click();
    for (const [arrow, back, end] of [
      ['Next attachment', 'ArrowLeft', mounted.length],
      ['Previous attachment', 'ArrowRight', 1],
    ] as const) {
      await page.getByRole('button', { name: arrow }).focus();
      for (let step = 1; step < mounted.length; step += 1) await page.keyboard.press('Enter');
      assert((await viewerPosition(page)) === end, `${label}: ${arrow} did not reach ${end}`);
      assert(await isFocusInViewer(page), `${label}: focus left the viewer at the end of ${arrow}`);
      await page.keyboard.press(back);
      assert(
        (await viewerPosition(page)) === (end === 1 ? 2 : end - 1),
        `${label}: ${back} did not step back from the end of ${arrow}`,
      );
    }
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

    // A PDF opens in the engine's own viewer as a PDF, never as the HTML a polyglot carries; where
    // the engine has no viewer it is saved, never shown as anything else.
    for (const [name, size] of [
      ['receipt.pdf', formatBytes(PDF_TEXT.length)],
      ['polyglot.pdf', formatBytes(POLYGLOT_PDF.length)],
    ] as const) {
      const open = () =>
        page.getByRole('button', { name: `Open ${name} in a new tab, ${size}` }).click();
      if (savesPdf(label)) {
        await assertSaved(context, page, open, `${label}: ${name}`);
        continue;
      }
      const tab = await openedTab(context, page, open, `${label}: ${name}`);
      const opened = await describeDocument(tab);
      assert(
        opened.contentType === 'application/pdf' && !opened.isParsed,
        `${label}: ${name} opened as ${JSON.stringify(opened)}`,
      );
      await tab.close();
    }
    const pdfUrls = await page.evaluate(() => (globalThis as HarnessWindow).openedUrls ?? []);
    assert(
      pdfUrls.length === 2 && pdfUrls.every(url => url.startsWith('blob:')),
      `${label}: expected both PDFs opened from blob URLs, got ${JSON.stringify(pdfUrls)}`,
    );
    await page.evaluate(() => (globalThis as HarnessWindow).attachmentSecurity?.unmount());
    for (const url of pdfUrls)
      await assertRevoked(page, url, `${label}: closing the message left a PDF URL alive`);

    // The browser half of the argument, independent of the policy: each type the app gives a blob
    // stays inert with hostile bytes inside, while the same bytes typed as markup are parsed.
    for (const [content, type, isMarkup] of [
      [HOSTILE_HTML, 'application/pdf', false],
      [POLYGLOT_PDF, 'application/pdf', false],
      [HOSTILE_HTML, 'image/png', false],
      [HOSTILE_SVG, 'image/png', false],
      [HOSTILE_HTML, 'text/html', true],
      [HOSTILE_SVG, 'image/svg+xml', true],
    ] as const) {
      const open = () =>
        page.evaluate(
          ({ body, blobType }) => {
            window.open(
              URL.createObjectURL(new Blob([body], { type: blobType })),
              '_blank',
              'noopener',
            );
          },
          { body: content, blobType: type },
        );
      // Saved is inert too: nothing of it is parsed into a document.
      if (type === 'application/pdf' && savesPdf(label)) {
        await assertSaved(context, page, open, `${label}: a ${type} blob`);
        continue;
      }
      const tab = await openedTab(context, page, open, `${label}: a ${type} blob`);
      const opened = await describeDocument(tab);
      assert(
        opened.isParsed === isMarkup,
        `${label}: a ${type} blob opened as ${JSON.stringify(opened)}`,
      );
      await tab.close();
    }

    // The host CSP, inherited by every blob document, also stopped the controls' inline scripts.
    await page.waitForTimeout(500);
    const messages = await page.evaluate(() => (globalThis as HarnessWindow).probeMessages);
    assert(
      messages?.length === 0,
      `${label}: an attachment payload ran script: ${JSON.stringify(messages)}`,
    );
    console.log(
      `✓ ${label}: attachments · policy · chips · bidi · text · image revoke · stepping · ${savesPdf(label) ? `PDFs saved (no viewer on Linux ${label})` : 'both PDFs in the viewer'} · blob types`,
    );
  } finally {
    await context.close();
  }
};
