#!/usr/bin/env node
/**
 * Writes the runtime secrets from process.env (loaded by the `varlock run` around the deploy) to the
 * JSON that `wrangler deploy --secrets-file` accepts.
 */
import { writeFileSync } from 'node:fs';
import SECRET_KEYS from './secret-keys.json' with { type: 'json' };

const outFile = process.argv[2];
if (!outFile) {
  console.error('Usage: varlock run -- node scripts/resolve-secrets.ts <out-file>');
  process.exit(1);
}

const resolved: Record<string, string> = {};
const missing: string[] = [];
for (const key of SECRET_KEYS) {
  const value = process.env[key];
  if (value) resolved[key] = value;
  else missing.push(key);
}

if (missing.length > 0) {
  console.error(`Could not resolve from 1Password: ${missing.join(', ')}`);
  console.error('Check 1Password auth and the Environment id in .env.schema.');
  process.exit(1);
}

writeFileSync(outFile, JSON.stringify(resolved), { mode: 0o600 });
