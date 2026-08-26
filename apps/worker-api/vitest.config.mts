import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
