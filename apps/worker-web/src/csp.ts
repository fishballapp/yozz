import { POSTHOG_HOST } from '@yozz.app/web-marketing/analytics';

/**
 * The origin's policy (apps/web/public/_headers, which the assets layer attaches to every file it
 * serves) with PostHog's ingest host added to `connect-src`: the one thing the analytics on the
 * landing page and the blog need. Every other byte stays as `_headers` wrote it, so the policies
 * cannot drift apart.
 */
export const withPostHogConnect = (policy: string): string => {
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

/** `page` with its CSP widened by `withPostHogConnect`, for a counted page. */
export const withAnalytics = (page: Response, path: string): Response => {
  const response = new Response(page.body, page);
  const policy = response.headers.get('Content-Security-Policy');
  if (policy === null) throw new Error(`${path} came back from the assets with no CSP`);
  response.headers.set('Content-Security-Policy', withPostHogConnect(policy));
  return response;
};
