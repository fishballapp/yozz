import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LIMBO_CACHE, LIMBO_SHA256, LIMBO_URL } from './pin.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const cached = await readFile(LIMBO_CACHE).catch(() => undefined);
if (cached !== undefined && sha256(cached) === LIMBO_SHA256) {
  console.log(`limbo.json cached and verified (${cached.length} bytes)`);
} else {
  console.log(`fetching ${LIMBO_URL}`);
  const response = await fetch(LIMBO_URL);
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== LIMBO_SHA256) {
    throw new Error(
      `hash mismatch for the pinned commit.\n  expected ${LIMBO_SHA256}\n  actual   ${actual}\n` +
        'If the pin was just bumped, paste this hash into harness/pin.ts.',
    );
  }
  await mkdir(dirname(LIMBO_CACHE), { recursive: true });
  await writeFile(LIMBO_CACHE, bytes);
  console.log(`fetched and verified (${bytes.length} bytes) -> ${LIMBO_CACHE}`);
}
