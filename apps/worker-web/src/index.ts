import { isSignedInCookieSet } from '@yozz.app/web/signed-in';
import { COOKIE_SETTINGS_PARAM, POSTHOG_HOST } from '@yozz.app/web-marketing/analytics';

type Env = { ASSETS: Fetcher };

/** The landing page's file in dist/, put there by scripts/assemble-assets.ts. Not exported: a
 * Worker module may export handlers only. */
const LANDING_PATH = '/_landing';

/**
 * The origin's policy (apps/web/public/_headers, which the assets layer attaches to every file it
 * serves, `/_landing` included) with PostHog's ingest host added to `connect-src`: the one thing
 * the landing page's analytics need. Every other byte stays as `_headers` wrote it, so the two
 * policies cannot drift apart.
 */
const withLandingAnalytics = (policy: string): string => {
  const directives = policy.split(';');
  const connectIndex = directives.findIndex(directive => /^\s*connect-src\s/.test(directive));
  if (connectIndex === -1) {
    throw new Error(`The origin's CSP has no connect-src to add ${POSTHOG_HOST} to: ${policy}`);
  }
  return directives
    .map((directive, index) =>
      index === connectIndex ? `${directive} ${POSTHOG_HOST}` : directive,
    )
    .join(';');
};

/**
 * yozz.app/ is two pages: the landing page for a visitor, the app for a browser that is signed in
 * (DECISIONS.md, "The landing page at /, and who skips it"). Only `/` runs this Worker
 * (`run_worker_first` in wrangler.jsonc); every other path is the assets layer's alone, so the app
 * is served exactly as before, and so is the app's own `/`. The landing page alone gets a CSP that
 * lets it reach PostHog (DECISIONS.md, "Analytics on the landing page only"). `/?cookie-settings`
 * is the landing page for a signed-in browser too: the one place it can change its cookie choice.
 */
export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname !== '/') return env.ASSETS.fetch(request);
    const isApp =
      !url.searchParams.has(COOKIE_SETTINGS_PARAM) &&
      isSignedInCookieSet(request.headers.get('Cookie'));
    const page = await env.ASSETS.fetch(
      isApp ? request : new Request(new URL(LANDING_PATH, request.url), request),
    );
    // The two pages share a URL, so no cache may hand one browser the other's.
    const response = new Response(page.body, page);
    response.headers.append('Vary', 'Cookie');
    if (isApp) return response;
    const policy = response.headers.get('Content-Security-Policy');
    if (policy === null) throw new Error(`${LANDING_PATH} came back from the assets with no CSP`);
    response.headers.set('Content-Security-Policy', withLandingAnalytics(policy));
    return response;
  },
} satisfies ExportedHandler<Env>;
