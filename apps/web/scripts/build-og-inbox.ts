// Builds assets/og-inbox.png, the inbox drawn inside the social card's envelope, from the landing
// page's own drawing (apps/web-marketing's MockInbox and its demo data), so the card shows what
// the page shows: `pnpm -F @yozz.app/web og:inbox`. Needs the landing page built first
// (`pnpm -F @yozz.app/web-marketing build`). `pnpm -F @yozz.app/web og` runs this, then build-og.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../web-marketing/dist');
const out = path.resolve(here, '../../../assets/og-inbox.png');

// 1440 is wide enough for all three panes. The card shows the drawing at 792px, so 2x that is the
// most it can use.
const viewport = { width: 1440, height: 900 };
const cardWidth = 792 * 2;

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
};

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  try {
    const file = readFileSync(path.join(dist, pathname === '/' ? 'index.html' : pathname));
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(pathname)] ?? 'application/octet-stream',
    });
    response.end(file);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('The server has no port.');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${address.port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.hero .app').screenshot({ path: out });
} finally {
  await browser.close();
  server.close();
}

execFileSync('magick', [out, '-filter', 'Lanczos', '-resize', `${cardWidth}x`, out]);
execFileSync('magick', ['identify', out], { stdio: 'inherit' });
