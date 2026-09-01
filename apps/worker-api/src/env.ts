export type RuntimeEnv = Env & {
  BETTER_AUTH_SECRET: string;
  FORWARD_EMAIL_ALIAS_PASSWORD: string;
  /** Absent under `wrangler dev`; the deploy script sets it with `--var MODE:production`. */
  MODE?: string;
  BASE_URL?: string;
  WEB_ORIGIN?: string;
};

export const getWebOrigin = (env: RuntimeEnv): string =>
  env.WEB_ORIGIN ?? (env.MODE === 'production' ? 'https://yozz.app' : 'http://localhost:5177');

export const getBaseUrl = (env: RuntimeEnv): string =>
  env.BASE_URL ?? (env.MODE === 'production' ? 'https://api.yozz.app' : 'http://localhost:8177');
