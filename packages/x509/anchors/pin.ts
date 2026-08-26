/**
 * The shipped trust store's two inputs, pinned by hash.
 *
 * Two files rather than one, and the second is not optional. `cacert.pem` is
 * NSS filtered to the roots trusted for server authentication, which is the
 * list we want — but PEM carries no metadata, so a root that Mozilla has
 * DISTRUSTED for certificates issued after a date looks in the bundle exactly
 * like one it has not. `certdata.txt` is where that date lives.
 *
 * **A root gaining a cutoff does not change the PEM at all**, so no amount of
 * diffing `cacert.pem` notices. Measured 2026-08-20: `Izenpe.com` carries a
 * 2026-04-15 server cutoff, is past it, and is still in curl's bundle
 * unannotated ([the call](../../../DECISIONS.md#the-shipped-roots-are-curls-cacertpem-and-the-cutoff-is-a-build-step-requirement)).
 *
 * To bump either: change the ref, run `pnpm -F @yozz.app/x509 anchors:fetch`, paste
 * the hash it prints, and re-run the build. **Read what moved before pasting** —
 * a root leaving the bundle and a root gaining a cutoff are both trust changes,
 * and the hash is the only thing that makes them arrive as a decision rather
 * than as a silent update.
 */

/** curl's bundle, republished on its own schedule rather than versioned. */
export const CACERT_URL = 'https://curl.se/ca/cacert.pem';
export const CACERT_SHA256 = 'f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9';

/**
 * NSS by COMMIT, not by branch. `.../nss/master/...` is a moving target, and a
 * moving trust input is the thing this whole file exists to prevent.
 */
export const CERTDATA_COMMIT = '70a8ff50d9abdd5424dc38c3bacda5ccbf58c985';
export const CERTDATA_URL = `https://raw.githubusercontent.com/nss-dev/nss/${CERTDATA_COMMIT}/lib/ckfw/builtins/certdata.txt`;
export const CERTDATA_SHA256 = '81b7f2576333a2e360e673f912d7b0b7a765d836c731003e348a46cac5d37198';

/** Gitignored, like `.limbo/` — see .gitignore. */
export const CACERT_CACHE = new URL('../.anchors/cacert.pem', import.meta.url).pathname;
export const CERTDATA_CACHE = new URL('../.anchors/certdata.txt', import.meta.url).pathname;
