import { isSignedInCookieSet } from '@yozz.app/web/signed-in';
import { COOKIE_SETTINGS_PARAM } from '@yozz.app/web-marketing/analytics';
import { isBlogPath, serveBlog } from './blog';
import { withAnalytics } from './csp';

type Env = { ASSETS: Fetcher };

/** The landing page's file in dist/, put there by scripts/assemble-assets.ts. Not exported: a
 * Worker module may export handlers only. */
const LANDING_PATH = '/_landing';

/**
 * yozz.app/ is two pages: the landing page for a visitor, the app for a browser that is signed in
 * (DECISIONS.md, "The landing page at /, and who skips it"). Only `/` and the blog run this Worker
 * (`run_worker_first` in wrangler.jsonc); every other path is the assets layer's alone, so the app
 * is served exactly as before, and so is the app's own `/`. The landing page and the blog alone get
 * a CSP that lets them reach PostHog (DECISIONS.md, "Analytics on the landing page only").
 * `/?cookie-settings` is the landing page for a signed-in browser too: the one place it can change
 * its cookie choice.
 */
export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    if (isBlogPath(url.pathname)) return serveBlog(request, env);
    if (url.pathname !== '/') return env.ASSETS.fetch(request);
    const isApp =
      !url.searchParams.has(COOKIE_SETTINGS_PARAM) &&
      isSignedInCookieSet(request.headers.get('Cookie'));
    const page = await env.ASSETS.fetch(
      isApp ? request : new Request(new URL(LANDING_PATH, request.url), request),
    );
    // The two pages share a URL, so no cache may hand one browser the other's.
    const response = isApp ? new Response(page.body, page) : withAnalytics(page, LANDING_PATH);
    response.headers.append('Vary', 'Cookie');
    return response;
  },
} satisfies ExportedHandler<Env>;
