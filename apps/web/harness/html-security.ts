/**
 * Adversarial browser gate for received HTML. Unit tests pin sanitizer output; this proves the
 * browser actually enforces the composed sanitizer + srcdoc CSP + opaque iframe sandbox across all
 * three engine families.
 *
 *   pnpm -F @yozz.app/web html:security
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type Page,
  webkit,
} from '@playwright/test';
import { createServer } from 'vite';

type HtmlModule = typeof import('../src/threads/html');
type MountResult = {
  readonly hasRemoteImages: boolean;
  readonly measuredHeight: number;
};
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEADERS_PATH = fileURLToPath(new URL('../public/_headers', import.meta.url));
const DIST_INDEX_PATH = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const HEIGHT_TIMEOUT_MS = 5_000;
const NETWORK_SETTLE_MS = 500;

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const headerValue = (source: string, name: string): string => {
  const prefix = `${name.toLowerCase()}:`;
  const line = source
    .split('\n')
    .map(value => value.trim())
    .find(value => value.toLowerCase().startsWith(prefix));
  assert(line !== undefined, `_headers is missing ${name}`);
  return line.slice(line.indexOf(':') + 1).trim();
};

const assertProductionDocumentHasNoInlineScripts = async (): Promise<void> => {
  const html = await readFile(DIST_INDEX_PATH, 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>/gi))
    assert(
      /(?:^|\s)src\s*=/i.test(match[1] ?? ''),
      'dist/index.html contains an inline script blocked by the production CSP',
    );
};

const mount = async (page: Page, html: string, allowRemoteImages: boolean): Promise<MountResult> =>
  page.evaluate(
    async ({ allow, body, heightTimeoutMs }) => {
      const module = (globalThis as typeof globalThis & { htmlSecurity?: HtmlModule }).htmlSecurity;
      if (module === undefined) throw new Error('HTML security module did not load');
      const result = module.buildMailFrame(body, { allowRemoteImages: allow });
      document.body.replaceChildren();
      const frame = document.createElement('iframe');
      frame.title = 'security probe';
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      frame.referrerPolicy = 'no-referrer';
      const loaded = new Promise<void>(resolve =>
        frame.addEventListener('load', () => resolve(), { once: true }),
      );
      const measuredHeight = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('mail frame did not report height')),
          heightTimeoutMs,
        );
        const onMessage = (event: MessageEvent) => {
          if (
            event.source !== frame.contentWindow ||
            event.data?.type !== 'yozz:mail-height' ||
            typeof event.data.height !== 'number'
          )
            return;
          clearTimeout(timeout);
          removeEventListener('message', onMessage);
          resolve(event.data.height);
        };
        addEventListener('message', onMessage);
      });
      frame.srcdoc = result.srcdoc;
      document.body.append(frame);
      await loaded;
      return { hasRemoteImages: result.hasRemoteImages, measuredHeight: await measuredHeight };
    },
    { allow: allowRemoteImages, body: html, heightTimeoutMs: HEIGHT_TIMEOUT_MS },
  );

const childFrameOf = (page: Page) => {
  const child = page.frames().find(frame => frame !== page.mainFrame());
  assert(child !== undefined, 'srcdoc iframe did not mount');
  return child;
};

const runEngine = async (
  label: string,
  browserType: BrowserType<Browser>,
  origin: string,
  csp: string,
) => {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const remoteRequests: Array<{ url: string; referrer?: string }> = [];
    const linkRequests: Array<{ url: string; referrer?: string }> = [];
    const forbiddenRequests: string[] = [];
    let scriptRequests = 0;
    await context.route(`${origin}/harness/html-security.html`, async route => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': csp },
      });
    });
    await context.route(`${origin}/harness/csp-probe.js`, async route => {
      scriptRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: "parent.postMessage({type:'csp-bypass'},'*')",
      });
    });
    await context.route('https://tracker.invalid/**', async route => {
      remoteRequests.push({
        url: route.request().url(),
        ...(route.request().headers().referer === undefined
          ? {}
          : { referrer: route.request().headers().referer }),
      });
      await route.fulfill({ status: 204 });
    });
    await context.route('https://example.invalid/**', async route => {
      linkRequests.push({
        url: route.request().url(),
        ...(route.request().headers().referer === undefined
          ? {}
          : { referrer: route.request().headers().referer }),
      });
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>external</title>',
      });
    });
    for (const pattern of [
      'https://unlisted.invalid/**',
      'https://yozz.app./**',
      'https://ev%22il.invalid/**',
    ])
      await context.route(pattern, async route => {
        forbiddenRequests.push(route.request().url());
        await route.fulfill({ status: 204 });
      });

    const page = await context.newPage();
    await page.goto(`${origin}/harness/html-security.html`);
    await page.waitForFunction(
      () =>
        (globalThis as typeof globalThis & { htmlSecurity?: HtmlModule }).htmlSecurity !==
        undefined,
    );
    const hostile = `
      <script>parent.postMessage({type:'attacker-script-ran'},'*')</script>
      <img src="https://tracker.invalid/image.gif" onerror="parent.postMessage('x','*')">
      <img id="app-dot-image" src="https://yozz.app./image.gif">
      <img id="csp-delimiter-image" src="https://ev%22il.invalid/image.gif">
      <div id="background" style="background-image:url(//tracker.invalid/background.gif)">remote</div>
      <div id="background-shorthand" style="background:url(https://tracker.invalid/background-shorthand.gif)">background</div>
      <div id="border-image" style="border-image:url(https://tracker.invalid/border.gif) 30">border</div>
      <div id="list-style" style="list-style:url(https://tracker.invalid/list.gif)">list</div>
      <div id="mask" style="mask:url(https://tracker.invalid/mask.gif)">mask</div>
      <div id="custom-property" style="--remote:url(https://tracker.invalid/custom.gif);background-image:var(--remote)">custom</div>
      <div id="escaped-background" style="background-image:u\\72l(https://tracker.invalid/escaped.gif)">escaped</div>
      <a id="valid" href="https://example.invalid/path">valid</a>
      <a id="slashless" href="https:settings/delete">slashless</a>
      <a id="credentials" href="https://visible.invalid@evil.invalid/path">credentials</a>
      <a id="app" href="https://yozz.app/settings/delete">app</a>
      <a id="app-dot" href="https://yozz.app./settings/delete">app dot</a>
      <svg><script>parent.postMessage('svg','*')</script></svg>
      <style>@import url(https://tracker.invalid/import.css); [x="<\\2f style><a id=pwn href=https://yozz.app/settings/delete>pwn<\\2f a><style>"]{color:red} .kept{max-width:600px}</style>
      <div class="kept" id="kept">kept</div>
      <div style="height:400px">height probe</div>
    `;

    let attackerScriptRan = false;
    await page.exposeFunction('recordAttackerMessage', () => {
      attackerScriptRan = true;
    });
    await page.evaluate(() => {
      addEventListener('message', event => {
        if (
          event.data?.type === 'attacker-script-ran' ||
          event.data?.type === 'csp-bypass' ||
          event.data === 'svg'
        ) {
          const bridge = globalThis as typeof globalThis & {
            recordAttackerMessage: () => Promise<void>;
          };
          void bridge.recordAttackerMessage();
        }
      });
    });

    const denied = await mount(page, hostile, false);
    assert(denied.hasRemoteImages, `${label}: remote image was not detected`);
    assert(denied.measuredHeight > 160, `${label}: mail frame did not measure its content`);
    await page.waitForTimeout(NETWORK_SETTLE_MS);
    assert(remoteRequests.length === 0, `${label}: blocked content made a network request`);
    assert(forbiddenRequests.length === 0, `${label}: forbidden origin made a network request`);
    assert(!attackerScriptRan, `${label}: sender script executed`);
    assert(
      (await page.locator('iframe').getAttribute('sandbox')) ===
        'allow-scripts allow-popups allow-popups-to-escape-sandbox',
      `${label}: iframe sandbox drifted`,
    );
    assert(
      (await page.locator('iframe').getAttribute('referrerpolicy')) === 'no-referrer',
      `${label}: iframe referrer policy drifted`,
    );

    const child = childFrameOf(page);
    const childCsp = await child
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    assert(childCsp?.includes("script-src 'nonce-") === true, `${label}: child CSP was truncated`);
    for (const id of [
      'background',
      'escaped-background',
      'background-shorthand',
      'border-image',
      'list-style',
      'mask',
      'custom-property',
    ])
      assert(
        !(await child.locator(`#${id}`).getAttribute('style'))?.includes('tracker'),
        `${label}: URL-bearing CSS survived on #${id}`,
      );
    assert(
      (await child.locator('#valid').getAttribute('href')) === 'https://example.invalid/path',
      `${label}: valid outward link was not retained`,
    );
    for (const id of ['slashless', 'credentials', 'app', 'app-dot'])
      assert(
        (await child.locator(`#${id}`).getAttribute('href')) === null,
        `${label}: unsafe #${id} link survived`,
      );
    assert(
      (await child.locator('#pwn').count()) === 0,
      `${label}: a stylesheet selector ended the frame's <style> and injected markup`,
    );
    assert(
      (await child.locator('#kept').evaluate(node => getComputedStyle(node).maxWidth)) === '600px',
      `${label}: sender stylesheet layout rule was not kept`,
    );
    for (const id of ['app-dot-image', 'csp-delimiter-image'])
      assert(
        (await child.locator(`#${id}`).getAttribute('src')) === null,
        `${label}: unsafe #${id} image survived`,
      );

    const parentUrl = page.url();
    const popupPromise = context.waitForEvent('page');
    await child.locator('#valid').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert(page.url() === parentUrl, `${label}: link navigated the mail client`);
    assert(
      popup.url() === 'https://example.invalid/path',
      `${label}: outward link opened ${popup.url()}`,
    );
    assert((await popup.evaluate(() => opener)) === null, `${label}: popup retained an opener`);
    assert(
      linkRequests.length === 1,
      `${label}: outward link request was not recorded exactly once`,
    );
    assert(linkRequests[0]?.referrer === undefined, `${label}: link leaked a referrer`);
    await popup.close();

    remoteRequests.length = 0;
    await mount(page, hostile, true);
    await page.waitForTimeout(NETWORK_SETTLE_MS);
    assert(
      remoteRequests.length === 1,
      `${label}: expected one opt-in image request, got ${JSON.stringify(remoteRequests)}`,
    );
    assert(
      remoteRequests.every(request => request.referrer === undefined),
      `${label}: opt-in content leaked a referrer`,
    );
    assert(
      remoteRequests[0]?.url.endsWith('/image.gif') === true,
      `${label}: the opt-in image request was not exercised`,
    );
    const allowedChild = childFrameOf(page);
    await allowedChild.evaluate(() => {
      const image = document.createElement('img');
      image.src = 'https://unlisted.invalid/not-in-csp.gif';
      document.body.append(image);
    });
    await page.waitForTimeout(NETWORK_SETTLE_MS);
    assert(
      forbiddenRequests.length === 0,
      `${label}: child CSP fetched an origin absent from img-src`,
    );
    await allowedChild.evaluate(probeOrigin => {
      const script = document.createElement('script');
      script.src = `${probeOrigin}/harness/csp-probe.js`;
      document.body.append(script);
    }, origin);
    await page.waitForTimeout(NETWORK_SETTLE_MS);
    assert(scriptRequests === 0, `${label}: child CSP fetched a script without a nonce`);
    assert(!attackerScriptRan, `${label}: child CSP executed a script without a nonce`);
    console.log(`✓ ${label}: sanitizer · CSP · sandbox · height · links · remote privacy`);
    await context.close();
  } finally {
    await browser.close();
  }
};

const headers = await readFile(HEADERS_PATH, 'utf8');
const csp = headerValue(headers, 'Content-Security-Policy');
await assertProductionDocumentHasNoInlineScripts();
// On the harness's loopback HTTP origin this directive makes WebKit upgrade Vite's module requests to an HTTPS server that does not exist.
const harnessCsp = csp.replace('; upgrade-insecure-requests', '');
for (const header of [
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
  'Referrer-Policy',
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'X-DNS-Prefetch-Control',
  'X-Frame-Options',
])
  headerValue(headers, header);

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
assert(origin !== undefined, 'Vite did not expose a local harness URL');
try {
  for (const [label, browserType] of [
    ['Chromium', chromium],
    ['Firefox', firefox],
    ['WebKit', webkit],
  ] as const)
    await runEngine(label, browserType, origin, harnessCsp);
} finally {
  await server.close();
}
