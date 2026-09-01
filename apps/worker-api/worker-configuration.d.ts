// MODE is absent from wrangler.jsonc vars on purpose; `scripts/deploy-worker.ts` sets it (`--var MODE:production`).

interface Env {
  DB: D1Database;
  RELAY_RATE_LIMIT: RateLimit;
  BETTER_AUTH_SECRET: string;
  FORWARD_EMAIL_ALIAS_PASSWORD: string;
  WEB_ORIGIN?: string;
  MODE?: string;
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare module 'cloudflare:test' {
  export const env: Env;
  export function reset(): Promise<void>;
  export interface D1Migration {
    name: string;
    queries: string[];
  }
  export function applyD1Migrations(
    db: D1Database,
    migrations: D1Migration[],
    migrationsTableName?: string,
  ): Promise<void>;
}
