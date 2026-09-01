/**
 * BoGo ships inside BoringSSL and moves with it. To bump: change the tag, the commit and
 * `BORINGSSL_TEST_COUNT` together, run `bogo:fetch`, then `bogo` and read the manifest diff.
 */
export const BORINGSSL_TAG = '0.20260813.0';
export const BORINGSSL_COMMIT = '7c1efd8d6ffb36a57feba44e8c73cf674801f3cb';
export const BORINGSSL_REPO = 'https://github.com/google/boringssl';

/** The inventory refuses to write a manifest from a sweep that saw a different count; see DECISIONS.md, "The BoGo gate". */
export const BORINGSSL_TEST_COUNT = 7895;

/** Gitignored. */
export const BORINGSSL_CHECKOUT = new URL('../../.bogo/boringssl', import.meta.url).pathname;

/** Where the Go runner lives inside that checkout. */
export const RUNNER_DIR = `${BORINGSSL_CHECKOUT}/ssl/test/runner`;
