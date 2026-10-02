#!/usr/bin/env node
/**
 * `pnpm -F @yozz.app/worker-api run deploy`: code and secrets in one `wrangler deploy`, then every
 * Worker secret not in SECRET_KEYS is deleted over the API (wrangler's `secret delete` is interactive only).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SECRET_KEYS from './secret-keys.json' with { type: 'json' };

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const workerName = wrangler.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
const accountId = wrangler.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1];
const deployToken = process.env.CLOUDFLARE_API_TOKEN;

if (!workerName || !accountId || !deployToken) {
  throw new Error(
    'Need "name" + "account_id" in wrangler.jsonc and CLOUDFLARE_API_TOKEN in the env.',
  );
}

const cfSecrets = async (method: string, suffix = ''): Promise<{ name: string }[]> => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets${suffix}`,
    { method, headers: { Authorization: `Bearer ${deployToken}` } },
  );
  const body = (await res.json()) as {
    success: boolean;
    errors?: unknown;
    result?: { name: string }[];
  };
  if (!body.success) {
    throw new Error(`Cloudflare API ${method} secrets${suffix}: ${JSON.stringify(body.errors)}`);
  }
  return body.result ?? [];
};

const tmp = mkdtempSync(join(tmpdir(), 'yozz-secrets-'));
const secretsFile = join(tmp, 'secrets.json');
try {
  execFileSync('node', [join(scriptsDir, 'resolve-secrets.ts'), secretsFile], { stdio: 'inherit' });

  // MODE is a `--var`, not a named wrangler env: named envs do not inherit `d1_databases`.
  execFileSync('wrangler', ['deploy', '--secrets-file', secretsFile, '--var', 'MODE:production'], {
    stdio: 'inherit',
  });

  const remote = await cfSecrets('GET');
  const stale = remote.map(secret => secret.name).filter(name => !SECRET_KEYS.includes(name));
  for (const name of stale) {
    console.log(`Pruning stale secret: ${name}`);
    await cfSecrets('DELETE', `/${name}`);
  }
  console.log(
    stale.length > 0
      ? `Reconciled — pruned ${stale.length} stale secret(s).`
      : 'Reconciled — nothing to prune.',
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
