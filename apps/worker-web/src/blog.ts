import { withAnalytics } from './csp';

type Env = { ASSETS: Fetcher };

/** The blog's served paths, written by scripts/assemble-assets.ts from the landing build. */
type BlogManifest = { html: readonly string[]; assets: readonly string[] };

const MANIFEST_PATH = '/_blog-manifest.json';
const NOT_FOUND_PATH = '/404';
const FEED_PATH = '/blog/rss.xml';
const FEED_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const parseManifest = (value: unknown): BlogManifest => {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${MANIFEST_PATH} is not an object`);
  }
  const html = 'html' in value ? value.html : undefined;
  const assets = 'assets' in value ? value.assets : undefined;
  if (!isStringList(html) || !isStringList(assets)) {
    throw new Error(`${MANIFEST_PATH} has no string lists "html" and "assets"`);
  }
  return { html, assets };
};

// The resolved manifest only: a promise shared across requests would tie one request to another's
// fetch, which workerd cancels. A failed load is not kept, so the next request tries again.
let manifest: BlogManifest | undefined;

const loadManifest = async (request: Request, env: Env): Promise<BlogManifest> => {
  if (manifest !== undefined) return manifest;
  const response = await env.ASSETS.fetch(new URL(MANIFEST_PATH, request.url));
  if (!response.ok) {
    throw new Error(`${MANIFEST_PATH} came back from the assets ${response.status}`);
  }
  manifest = parseManifest(await response.json());
  return manifest;
};

/** The address a blog page is served at: no trailing slash, no `.html`. */
const canonicalPath = (pathname: string): string =>
  (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname).replace(/\.html$/, '');

export const isBlogPath = (pathname: string): boolean =>
  pathname === '/blog' || pathname.startsWith('/blog/');

/**
 * /blog and /blog/*: a page, counted like the landing page and the same for every browser, so its
 * CSP gets PostHog's host and no `Vary: Cookie`; a file (the feed) as the assets serve it; another
 * spelling of a page sent to the page; and anything else the 404 page under status 404, never the
 * app's shell, which the assets layer would answer with a 200.
 */
export const serveBlog = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const { pathname, search } = new URL(request.url);
  const { html, assets } = await loadManifest(request, env);
  if (html.includes(pathname)) return withAnalytics(await env.ASSETS.fetch(request), pathname);
  if (assets.includes(pathname)) {
    const asset = await env.ASSETS.fetch(request);
    if (pathname !== FEED_PATH || (!asset.ok && asset.status !== 304)) return asset;
    const response = new Response(asset.body, asset);
    response.headers.set('Content-Type', FEED_CONTENT_TYPE);
    return response;
  }
  const canonical = canonicalPath(pathname);
  if (html.includes(canonical)) {
    return Response.redirect(new URL(`${canonical}${search}`, request.url).href, 307);
  }
  const notFound = await env.ASSETS.fetch(
    new Request(new URL(NOT_FOUND_PATH, request.url), { method: request.method }),
  );
  return new Response(request.method === 'HEAD' ? null : notFound.body, {
    status: 404,
    headers: notFound.headers,
  });
};
