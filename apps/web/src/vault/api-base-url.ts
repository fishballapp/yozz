/**
 * Where the Worker lives. One answer for Better Auth and for the vault API,
 * because a session cookie set by one origin is useless against another.
 *
 * `window.__YOZZ_API_URL__` is a development-only override used by browser harnesses and an
 * already-running local Vite server. YOZZ has one production target: its build-time `VITE_API_URL`
 * must be `https://api.yozz.app`, the destination admitted by the static `connect-src` policy.
 */
const developmentOverride = (): string | undefined =>
  import.meta.env.DEV ? (globalThis as { __YOZZ_API_URL__?: string }).__YOZZ_API_URL__ : undefined;

export const getApiBaseUrl = (): string => {
  return developmentOverride() ?? import.meta.env.VITE_API_URL ?? 'https://api.yozz.app';
};

/**
 * Whether a Worker URL was actually SUPPLIED. `getApiBaseUrl()` always answers,
 * falling back to the production host, so a local build with nothing configured
 * would silently talk to prod. A screen that asks this instead says so.
 */
export const isApiConfigured = (): boolean =>
  developmentOverride() !== undefined || import.meta.env.VITE_API_URL !== undefined;
