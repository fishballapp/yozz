/** A shallow fetch of the pinned commit; the commit id is the integrity check. */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BORINGSSL_CHECKOUT, BORINGSSL_COMMIT, BORINGSSL_REPO, BORINGSSL_TAG } from './pin.ts';

const git = (...args: readonly string[]): string =>
  execFileSync('git', ['-C', BORINGSSL_CHECKOUT, ...args], { encoding: 'utf8' }).trim();

// A missing checkout is the normal first run.
const head = (): string | undefined => {
  try {
    return execFileSync('git', ['-C', BORINGSSL_CHECKOUT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

if (head() === BORINGSSL_COMMIT) {
  console.log(`boringssl ${BORINGSSL_TAG} already checked out at ${BORINGSSL_CHECKOUT}`);
} else {
  console.log(`fetching boringssl ${BORINGSSL_TAG} (${BORINGSSL_COMMIT})`);
  mkdirSync(BORINGSSL_CHECKOUT, { recursive: true });
  git('init', '--quiet');
  git('fetch', '--quiet', '--depth', '1', BORINGSSL_REPO, BORINGSSL_COMMIT);
  git('checkout', '--quiet', '--force', BORINGSSL_COMMIT);
  console.log(`checked out ${git('rev-parse', 'HEAD')} -> ${BORINGSSL_CHECKOUT}`);
}
