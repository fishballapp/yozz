/**
 * BoringSSL is pinned to a release tag, because BoGo ships *inside* the library
 * and moves with it — an unpinned runner silently changes which tests exist, and
 * therefore what the in-scope manifest means.
 *
 * To bump: change the tag, the commit and `BORINGSSL_TEST_COUNT` together, run
 * `pnpm -F @yozz.app/tls bogo:fetch`, then `bogo` and read what the manifest gained
 * or lost. A moved denominator is the thing to look at.
 */
export const BORINGSSL_TAG = '0.20260813.0';
export const BORINGSSL_COMMIT = '7c1efd8d6ffb36a57feba44e8c73cf674801f3cb';
export const BORINGSSL_REPO = 'https://github.com/google/boringssl';

/**
 * How many tests that pin has, and the inventory refuses to write a manifest
 * from a sweep that saw a different number.
 *
 * The inventory builds the manifest out of whatever the sweep observed, so a
 * runner that stops early — a broken stdout pipe is enough, and was — produces a
 * SHORTER manifest and says nothing. That arrives as an ordinary-looking diff
 * and quietly shrinks the gate's denominator; it took the manifest from 432
 * tests to 207 once, undetected until the count was read by hand.
 *
 * Bump it with the pin, deliberately: a moved denominator is the thing to look at.
 */
export const BORINGSSL_TEST_COUNT = 7895;

/** Gitignored — see .gitignore. */
export const BORINGSSL_CHECKOUT = new URL('../../.bogo/boringssl', import.meta.url).pathname;

/** Where the Go runner lives inside that checkout. */
export const RUNNER_DIR = `${BORINGSSL_CHECKOUT}/ssl/test/runner`;
