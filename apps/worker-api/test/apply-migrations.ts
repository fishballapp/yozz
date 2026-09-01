import { applyD1Migrations, reset } from 'cloudflare:test';
import migration0001 from '../migrations/0001_app_tables.sql?raw';
import migration0002 from '../migrations/0002_better_auth.sql?raw';
import migration0003 from '../migrations/0003_immutable_email.sql?raw';
import migration0004 from '../migrations/0004_better_auth_account_issuer.sql?raw';
import migration0005 from '../migrations/0005_vault_record_revision.sql?raw';

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

export const applyMigrations = async (db: D1Database): Promise<void> => {
  await reset();
  const migrations = [
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
  ];
  await applyD1Migrations(db, migrations);
};
