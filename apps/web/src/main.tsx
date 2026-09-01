import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen';
import './styles/global.css';

// File-based routing: routeTree.gen.ts is generated from src/routes/* by the tanstackRouter()
// Vite plugin (see vite.config.ts).
// `@` stays literal in the path: a thread id is `mid/<Message-ID>` (`lib/thread.ts`), and
// `/t/mid/<abc@x.com>` should read in the address bar the way it is typed. The router
// percent-encodes the brackets and decodes the splat on match either way. The fallback id
// (`address/folder/uidValidity/uid`) carries an `@` too, for the same reason.
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  pathParamsAllowedCharacters: ['@'],
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  /** How a page surface tells the shell its name, for the mobile top bar and the status line. */
  interface StaticDataRouteOption {
    title?: string;
  }
}

// A deploy retires the previous build's hashed chunks, so the first lazy import after one fails.
// Vite reports that as `vite:preloadError`; the answer is the new build, i.e. a reload — once.
// The draft being written survives it (`lib/draft-store.ts`). A second failure inside a minute is
// not a stale build, and reloading forever would hide it.
const RELOADED_AT = 'yozz:reloaded-for-preload';
window.addEventListener('vite:preloadError', event => {
  const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
  if (Date.now() - last < 60_000) return;
  event.preventDefault();
  sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  window.location.reload();
});

const root = document.getElementById('root');
if (root === null) throw new Error('Root element #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
