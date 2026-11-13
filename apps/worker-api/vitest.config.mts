import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// `src/temporal.ts` forces the Temporal polyfill over the runtime's own, and a test file has no
// entry to import it first: a setup file runs before the test's module graph loads.
export default defineConfig({
  test: { setupFiles: ['./src/temporal.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: {
          DB: 'yozz',
        },
        bindings: {
          MODE: 'production',
          BETTER_AUTH_SECRET: 'test_better_auth_secret_that_is_at_least_32_bytes_long',
          FORWARD_EMAIL_ALIAS_PASSWORD: 'test_forward_email_password',
        },
      },
    }),
  ],
});
