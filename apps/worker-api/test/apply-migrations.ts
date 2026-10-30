import { applyD1Migrations, reset } from 'cloudflare:test';
import migration0001 from '../migrations/0001_app_tables.sql?raw';
import migration0002 from '../migrations/0002_better_auth.sql?raw';
import migration0003 from '../migrations/0003_immutable_email.sql?raw';
import migration0004 from '../migrations/0004_better_auth_account_issuer.sql?raw';
import migration0005 from '../migrations/0005_vault_record_revision.sql?raw';
import migration0006 from '../migrations/0006_remove_better_auth_account_issuer.sql?raw';
import migration0007 from '../migrations/0007_vault_user_foreign_keys.sql?raw';
import migration0008 from '../migrations/0008_vault_cli_key.sql?raw';

const splitSql = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    if (!trimmed) continue;

    current += (current ? '\n' : '') + line;

    if (/\bBEGIN\b/i.test(trimmed)) {
      inTrigger = true;
    }
    if (/\bEND\s*;/i.test(trimmed)) {
      inTrigger = false;
      statements.push(current.trim());
      current = '';
      continue;
    }

    if (!inTrigger && trimmed.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
};

const MIGRATIONS = [
  {
    name: '0001_app_tables.sql',
    queries: splitSql(migration0001),
  },
  {
    name: '0002_better_auth.sql',
    queries: splitSql(migration0002),
  },
  {
    name: '0003_immutable_email.sql',
    queries: splitSql(migration0003),
  },
  {
    name: '0004_better_auth_account_issuer.sql',
    queries: splitSql(migration0004),
  },
  {
    name: '0005_vault_record_revision.sql',
    queries: splitSql(migration0005),
  },
  {
    name: '0006_remove_better_auth_account_issuer.sql',
    queries: splitSql(migration0006),
  },
  {
    name: '0007_vault_user_foreign_keys.sql',
    queries: splitSql(migration0007),
  },
  {
    name: '0008_vault_cli_key.sql',
    queries: splitSql(migration0008),
  },
];

/** `through` stops after that many migrations, to seed the data an upgrade has to carry over. */
export const applyMigrations = async (
  db: D1Database,
  { through = MIGRATIONS.length }: { readonly through?: number } = {},
): Promise<void> => {
  await reset();
  await applyD1Migrations(db, MIGRATIONS.slice(0, through));
};

/** The migrations `applyMigrations({ through })` left out. */
export const applyPendingMigrations = (db: D1Database): Promise<void> =>
  applyD1Migrations(db, MIGRATIONS);
