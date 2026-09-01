/**
 * Two inputs, both required: `cacert.pem` carries no metadata, so a root Mozilla distrusted for
 * new issuance looks like any other; `certdata.txt` is where the date lives. To bump: change the
 * ref, run `pnpm -F @yozz.app/x509 anchors:fetch`, paste the hash, rebuild. Read what moved first.
 */

/** curl's bundle, republished on its own schedule rather than versioned. */
export const CACERT_URL = 'https://curl.se/ca/cacert.pem';
export const CACERT_SHA256 = 'f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9';

/** By commit: a moving trust input is what pinning exists to prevent. */
export const CERTDATA_COMMIT = '70a8ff50d9abdd5424dc38c3bacda5ccbf58c985';
export const CERTDATA_URL = `https://raw.githubusercontent.com/nss-dev/nss/${CERTDATA_COMMIT}/lib/ckfw/builtins/certdata.txt`;
export const CERTDATA_SHA256 = '81b7f2576333a2e360e673f912d7b0b7a765d836c731003e348a46cac5d37198';

/** Gitignored, like `.limbo/` — see .gitignore. */
export const CACERT_CACHE = new URL('../.anchors/cacert.pem', import.meta.url).pathname;
export const CERTDATA_CACHE = new URL('../.anchors/certdata.txt', import.meta.url).pathname;
