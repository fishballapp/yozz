/**
 * One answer for Better Auth and the vault API, because a session cookie is per origin.
 * `window.__YOZZ_API_URL__` is a development-only override. `VITE_API_URL` must be
 * `https://api.yozz.app`, the destination the static `connect-src` admits.
 */
const developmentOverride = (): string | undefined =>
  import.meta.env.DEV ? (globalThis as { __YOZZ_API_URL__?: string }).__YOZZ_API_URL__ : undefined;

export const getApiBaseUrl = (): string => {
  return developmentOverride() ?? import.meta.env.VITE_API_URL ?? 'https://api.yozz.app';
};

/** `getApiBaseUrl()` falls back to production, so a local build with nothing configured would silently talk to prod. */
export const isApiConfigured = (): boolean =>
  developmentOverride() !== undefined || import.meta.env.VITE_API_URL !== undefined;
