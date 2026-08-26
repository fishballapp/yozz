declare module 'cloudflare:test' {
  interface ProvidedEnv {
    MODE: 'production';
    DB: D1Database;
    BETTER_AUTH_SECRET: string;
    FORWARD_EMAIL_ALIAS_PASSWORD: string;
  }
}
