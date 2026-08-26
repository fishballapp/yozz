export type RuntimeEnv = Env & {
  BETTER_AUTH_SECRET: string;
  FORWARD_EMAIL_ALIAS_PASSWORD: string;
  // Optional: absent under `wrangler dev` (localhost fallbacks); set to "production" by
  // `scripts/deploy-worker.ts` via `--var MODE:production`. Not declared in wrangler.jsonc
  // vars so local dev cannot accidentally inherit production origins.
  MODE?: string;
  BASE_URL?: string;
  WEB_ORIGIN?: string;
};

export const getWebOrigin = (env: RuntimeEnv): string =>
  env.WEB_ORIGIN ?? (env.MODE === 'production' ? 'https://yozz.app' : 'http://localhost:5177');

export const getBaseUrl = (env: RuntimeEnv): string =>
  env.BASE_URL ?? (env.MODE === 'production' ? 'https://api.yozz.app' : 'http://localhost:8787');
