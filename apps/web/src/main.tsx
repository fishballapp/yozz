// A deploy retires the previous build's chunks, so the first lazy import after one fails
// (`vite:preloadError`); reload once. A second failure inside a minute is not a stale build.
const RELOADED_AT = 'yozz:reloaded-for-preload';
window.addEventListener('vite:preloadError', event => {
  const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
  if (Date.now() - last < 60_000) return;
  event.preventDefault();
  sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  window.location.reload();
});

// Safari has no native Temporal, so it alone downloads the polyfill. The app is imported after
// it, never statically, so no module reads `Temporal` before the polyfill has installed it.
if (!('Temporal' in globalThis)) await import('temporal-polyfill/global');
await import('./app');

export {};
