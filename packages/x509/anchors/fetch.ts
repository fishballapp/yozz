/**
 * Fetch and verify the two trust inputs. Same shape as `harness/fetch.ts`, and
 * deliberately so — a hash mismatch here is a trust change, and it should read
 * the same way a moved conformance corpus does.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CACERT_CACHE,
  CACERT_SHA256,
  CACERT_URL,
  CERTDATA_CACHE,
  CERTDATA_SHA256,
  CERTDATA_URL,
} from './pin.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const fetchPinned = async (name: string, url: string, expected: string, cache: string) => {
  const cached = await readFile(cache).catch(() => undefined);
  if (cached !== undefined && sha256(cached) === expected) {
    console.log(`${name} cached and verified (${cached.length} bytes)`);
    return;
  }
  console.log(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(
      `hash mismatch for ${name}.\n  expected ${expected}\n  actual   ${actual}\n` +
        'This is a TRUST CHANGE, not a version bump. Diff what moved — a root added, a root\n' +
        'removed, or a root that gained a distrust-after cutoff — then paste the hash into\n' +
        'anchors/pin.ts.',
    );
  }
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, bytes);
  console.log(`fetched and verified (${bytes.length} bytes) -> ${cache}`);
};

await fetchPinned('cacert.pem', CACERT_URL, CACERT_SHA256, CACERT_CACHE);
await fetchPinned('certdata.txt', CERTDATA_URL, CERTDATA_SHA256, CERTDATA_CACHE);
