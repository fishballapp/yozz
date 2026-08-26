import { stripHtmlComments } from '@fishballapps/vite-plugins/strip-html-comments';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA builds to ./dist, to be served in production as Workers Static Assets (see AGENTS.md —
// no worker-web yet). tanstackRouter() must precede react() — it generates src/routeTree.gen.ts
// from src/routes/*.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    stripHtmlComments(),
  ],
  server: { port: 5177 },
  build: { outDir: 'dist', sourcemap: false },
});
