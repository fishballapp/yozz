// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { marketing } from '@internal/marketing/integration';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// The landing page at yozz.app/, the blog at /blog and the policies, served by the yozz-web Worker
// beside the app (../worker-web/scripts/assemble-assets.ts puts this build beside the app's).
export default defineConfig({
  site: 'https://yozz.app',
  trailingSlash: 'never',
  build: { format: 'file' },
  // A fenced block is the terminal's ink box (BlogPost.astro); Shiki's inline colours would override it.
  markdown: { syntaxHighlight: false },
  integrations: [
    mdx(),
    // The feed and the 404 page are not pages to search for.
    sitemap({
      filter: page => {
        const { pathname } = new URL(page);
        return !pathname.endsWith('.xml') && pathname !== '/404';
      },
    }),
    marketing(),
  ],
  vite: {
    plugins: [tailwindcss()],
    // Nothing inlined: the origin's CSP (apps/web/public/_headers) runs no inline script, and
    // Astro inlines a small one unless this is 0.
    build: { assetsInlineLimit: 0 },
  },
});
