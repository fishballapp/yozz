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

const root = document.getElementById('root');
if (root === null) throw new Error('Root element #root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
