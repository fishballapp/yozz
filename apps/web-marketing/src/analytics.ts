/**
 * The marketing analytics, read by the counted pages (landing and blog) and by the yozz-web Worker,
 * which adds the ingest host to those pages' CSP and to no other (DECISIONS.md, "Analytics on the
 * landing page only", "The blog at /blog").
 */

// Public key of YOZZ's own PostHog "web" project (docs/marketing-stack.md, Analytics); safe to
// commit. The build stops while this is not a project key (src/layouts/Counted.astro).
export const POSTHOG_API_KEY: string = 'phc_mCUyqjkzAuKvWke9BqMyDJcGd2x4ohShr9txW7YpnDag';

// PostHog's EU ingest host, where the project lives. The landing page's and blog's connect-src list it.
export const POSTHOG_HOST = 'https://eu.i.posthog.com';

// `yozz.app/?cookie-settings` is the landing page for everyone, signed in or not, with the cookie
// banner open: the one place a person who uses the app can change their choice (DECISIONS.md,
// "Cookie settings for someone who uses the app"). The privacy policy links it.
export const COOKIE_SETTINGS_PARAM = 'cookie-settings';
