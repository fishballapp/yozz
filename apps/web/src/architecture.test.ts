import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The folder rule, checked rather than remembered. `src/` is split by product noun (vault,
 * addresses, relay, threads, compose, agent), with `ui/` below every context, `store/` composing
 * their non-React modules, and `app/` + `routes/` on top. A cycle between files is the one shape
 * that always means a module is in the wrong folder.
 */
const SRC = import.meta.dirname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')
      ? [path]
      : [];
  });

const resolveImport = (from: string, spec: string): string | null => {
  const base = join(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
};

const files = walk(SRC);
const imports = new Map(
  files.map(file => [
    file,
    [...readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*)'(\.\.?\/[^']+)'/g)].flatMap(
      match => {
        const target = resolveImport(file, match[1] ?? '');
        return target === null ? [] : [target];
      },
    ),
  ]),
);
const rel = (file: string) => relative(SRC, file);
const folderOf = (file: string) =>
  rel(file).includes('/') ? (rel(file).split('/')[0] ?? '') : 'root';

describe('src/ folder rule', () => {
  it('has no import cycles between files', () => {
    const cycles = new Set<string>();
    const visit = (file: string, stack: readonly string[]) => {
      const at = stack.indexOf(file);
      if (at !== -1) {
        cycles.add([...stack.slice(at), file].map(rel).join(' -> '));
        return;
      }
      for (const next of imports.get(file) ?? []) visit(next, [...stack, file]);
    };
    for (const file of files) visit(file, []);
    expect([...cycles]).toEqual([]);
  });

  it('keeps ui/ free of every context', () => {
    const leaks = files
      .filter(file => folderOf(file) === 'ui')
      .flatMap(file =>
        (imports.get(file) ?? [])
          .filter(target => folderOf(target) !== 'ui')
          .map(target => `${rel(file)} -> ${rel(target)}`),
      );
    expect(leaks).toEqual([]);
  });

  it('lets only routes/, app/ and dev/ reach app/ and routes/', () => {
    const leaks = files
      .filter(file => !['routes', 'app', 'dev', 'root'].includes(folderOf(file)))
      .flatMap(file =>
        (imports.get(file) ?? [])
          .filter(target => ['routes', 'app'].includes(folderOf(target)))
          .map(target => `${rel(file)} -> ${rel(target)}`),
      );
    expect(leaks).toEqual([]);
  });
});
