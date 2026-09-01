/** Pinned by commit and hash: 39 MB does not belong in git, and an unpinned suite changes what green means. To bump: change COMMIT, run `limbo:fetch`, paste the hash. */
export const LIMBO_COMMIT = 'c6040f178a947b3fa4d4a5c118d5594f0e0ca6e2';
export const LIMBO_SHA256 = 'b25eab8e2eb3aa4e256a2bafbd01ae011627ac085ea7b7c72e0f51bce44c8f5e';
export const LIMBO_URL = `https://raw.githubusercontent.com/C2SP/x509-limbo/${LIMBO_COMMIT}/limbo.json`;

/** Gitignored — see .gitignore. */
export const LIMBO_CACHE = new URL('../.limbo/limbo.json', import.meta.url).pathname;
