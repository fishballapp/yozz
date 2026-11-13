// @ts-check

import sitemap from '@astrojs/sitemap';
import { marketing } from '@internal/marketing/integration';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// One page, served at yozz.app/ by the yozz-web Worker beside the app
// (../worker-web/scripts/assemble-assets.ts puts this build beside the app's).
export default defineConfig({
  site: 'https://yozz.app',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [sitemap(), marketing()],
  vite: {
    plugins: [tailwindcss()],
    // Nothing inlined: the origin's CSP (apps/web/public/_headers) runs no inline script, and
    // Astro inlines a small one unless this is 0.
    build: { assetsInlineLimit: 0 },
  },
});
