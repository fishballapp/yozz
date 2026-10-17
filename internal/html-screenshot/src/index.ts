// Screenshots HTML with the headless shell that puppeteer pins, not the Chrome installed on the
// machine. The installed Chrome stalls in teardown after writing its PNG, and the script fails on
// its watchdog. The shell exits cleanly, and at the same Chrome version it renders the committed
// promo and site images as the installed Chrome does, to within a level of antialiasing. It
// rasterises blur, shadow and gradient effects without the GPU, so a page that relies on them
// renders differently; those pages stay on the installed Chrome. See docs/conventions/promo.md.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

const run = promisify(execFile);

/** Callers downsample to the size they publish, so small type stays sharp. */
const DEVICE_SCALE = 2;

export type ScreenshotOptions = {
  /** The viewport in CSS pixels. The PNG is twice that in each direction. */
  width: number;
  height: number;
  /** Paints the page's background transparent, for a card drawn in layers to composite. */
  transparent?: boolean;
};

/** A URL with a scheme (`file:`, `http:`, `https:`) as given, anything else as a file path. */
const toUrl = (source: string): string =>
  /^(file|https?):/.test(source) ? source : pathToFileURL(source).href;

/**
 * Screenshots `source`, an HTML file path or a URL (a query string included), as a PNG at 2x. The
 * flags are the ones the committed images were rendered with. The fresh profile keeps one render
 * from leaking into the next.
 */
export const screenshotHtml = async (
  source: string,
  { width, height, transparent = false }: ScreenshotOptions,
): Promise<Buffer> => {
  const executablePath = await puppeteer.executablePath({ headless: 'shell' });
  const dir = mkdtempSync(path.join(tmpdir(), 'html-screenshot-'));
  const png = path.join(dir, 'screenshot.png');
  try {
    await run(executablePath, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // The templates load their fonts and style sheets from files beside them.
      '--allow-file-access-from-files',
      '--virtual-time-budget=4000',
      `--force-device-scale-factor=${DEVICE_SCALE}`,
      `--window-size=${width},${height}`,
      ...(transparent ? ['--default-background-color=00000000'] : []),
      `--user-data-dir=${dir}`,
      `--screenshot=${png}`,
      toUrl(source),
    ]);
    return readFileSync(png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
