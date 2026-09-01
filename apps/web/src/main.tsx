import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen';
import './styles/global.css';

// `@` stays literal: `/t/mid/<abc@x.com>` should read in the address bar as typed. The router
// percent-encodes the brackets and decodes the splat on match either way.
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  pathParamsAllowedCharacters: ['@'],
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  /** How a page surface tells the shell its name. */
  interface StaticDataRouteOption {
    title?: string;
  }
}

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

const root = document.getElementById('root');
if (root === null) throw new Error('Root element #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
