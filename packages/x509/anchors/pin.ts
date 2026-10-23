/**
 * Two inputs, both required: `cacert.pem` carries no metadata, so a root Mozilla distrusted for new
 * issuance looks like any other; `certdata.txt` is where the date lives. To bump: change the ref,
 * run `anchors:fetch`, paste the hash, rebuild. Read what moved first.
 */

/** curl's bundle, republished on its own schedule rather than versioned. */
export const CACERT_URL = 'https://curl.se/ca/cacert.pem';
export const CACERT_SHA256 = '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe';

/** By commit: a moving trust input is what pinning exists to prevent. */
export const CERTDATA_COMMIT = '0a2b0c75fa036930d98331b721c0780693a3e17a';
export const CERTDATA_URL = `https://raw.githubusercontent.com/nss-dev/nss/${CERTDATA_COMMIT}/lib/ckfw/builtins/certdata.txt`;
export const CERTDATA_SHA256 = '3ec2b4d240dc12c747eaf450061db84af757c483bbda302f9e29ceb5d70be510';

/** Gitignored, like `.limbo/` — see .gitignore. */
export const CACERT_CACHE = new URL('../.anchors/cacert.pem', import.meta.url).pathname;
export const CERTDATA_CACHE = new URL('../.anchors/certdata.txt', import.meta.url).pathname;
