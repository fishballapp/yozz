declare module 'cloudflare:test' {
  interface ProvidedEnv {
    MODE: 'production';
    DB: D1Database;
    FILES: R2Bucket;
    BETTER_AUTH_SECRET: string;
    FORWARD_EMAIL_ALIAS_PASSWORD: string;
  }
}

/** A source file as text, through Vite, which the workers pool runs these tests on. */
declare module '*.ts?raw' {
  const source: string;
  export default source;
}

interface ImportMeta {
  /** Vite's, eager and as text: the sources a test reads to hold a rule no test can observe. */
  glob<T>(
    patterns: readonly string[],
    options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
  ): Record<string, T>;
}
