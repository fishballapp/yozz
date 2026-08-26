/**
 * x509-limbo is pinned to a commit and verified by hash, because 39MB does not
 * belong in git and an unpinned suite silently changes what "green" means.
 *
 * To bump: change COMMIT, run `pnpm -F @yozz.app/x509 limbo:fetch`, paste the hash
 * it prints, and re-run the suite. A moved denominator is the thing to look at.
 */
export const LIMBO_COMMIT = 'c6040f178a947b3fa4d4a5c118d5594f0e0ca6e2';
export const LIMBO_SHA256 = 'b25eab8e2eb3aa4e256a2bafbd01ae011627ac085ea7b7c72e0f51bce44c8f5e';
export const LIMBO_URL = `https://raw.githubusercontent.com/C2SP/x509-limbo/${LIMBO_COMMIT}/limbo.json`;

/** Gitignored — see .gitignore. */
export const LIMBO_CACHE = new URL('../.limbo/limbo.json', import.meta.url).pathname;
