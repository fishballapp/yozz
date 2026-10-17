// Builds apps/web/public/og.png from assets/og-card.html: `pnpm -F @yozz.app/web og`.
//
// Two passes, because the card's layers want opposite treatment.
//
// The type is vector and the app screenshot is downscaled, so both come out cleaner rendered at 2x
// and resampled down: on the app's list rows the difference is plain, and the result is smaller
// too, since the downsample removes high-frequency noise PNG was paying to encode.
//
// envelope.png is the exception. It is already exactly 1200x630, so at 1x it maps one image pixel
// to one output pixel and its paper grain survives intact. Put it through the same 2x round trip
// and the grain averages away, which is the one thing the generated envelope is there for.
//
// So: render everything under the type at 2x and resample it down, composite the envelope at its
// native pixels over that, then lay the separately supersampled type on top.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { screenshotHtml } from '@fishballapps/html-screenshot';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../../../assets');
const card = pathToFileURL(path.join(assets, 'og-card.html')).href;
const out = path.resolve(here, '../public/og.png');
const size = { width: 1200, height: 630 };

const tmp = mkdtempSync(path.join(tmpdir(), 'yozz-og-'));
try {
  const base = path.join(tmp, 'base.png');
  const type = path.join(tmp, 'type.png');
  writeFileSync(base, await screenshotHtml(`${card}?layer=base`, size));
  writeFileSync(type, await screenshotHtml(`${card}?layer=type`, { ...size, transparent: true }));

  const baseSmall = path.join(tmp, 'base-1x.png');
  const typeSmall = path.join(tmp, 'type-1x.png');
  execFileSync('magick', [base, '-filter', 'Lanczos', '-resize', '1200x630', baseSmall]);
  execFileSync('magick', [type, '-filter', 'Lanczos', '-resize', '1200x630', typeSmall]);

  execFileSync('magick', [
    baseSmall,
    path.join(assets, 'envelope.png'),
    '-composite',
    typeSmall,
    '-composite',
    out,
  ]);

  // Chrome writes 24-bit PNG and the paper grain costs ~300KB of it, over the ~300KB at which
  // WhatsApp stops fetching a card. A palette takes it to ~80KB and, unlike JPEG at the same size,
  // leaves the app's text crisp.
  execFileSync('pngquant', [
    '--quality',
    '70-92',
    '--speed',
    '1',
    '--strip',
    '--force',
    '--output',
    out,
    out,
  ]);
  execFileSync('magick', ['identify', out], { stdio: 'inherit' });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
