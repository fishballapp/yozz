import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The folder rule, checked rather than remembered: `src/` is split by product noun, with `ui/`
 * below every context, `store/` composing their non-React modules, and `app/` + `routes/` on top. A
 * cycle between files always means a module is in the wrong folder. `@yozz.app/mail` is the
 * contexts' shared logic, so its files are in the graph too.
 */
const SRC = import.meta.dirname;
/** `@yozz.app/mail` exports each of its modules by path, so an import of one is followed into it. */
const MAIL_SRC = join(SRC, '../../../internal/mail/src');
const MAIL = '@yozz.app/mail/';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')
      ? [path]
      : [];
  });

const resolveImport = (from: string, spec: string): string | null => {
  const base = spec.startsWith(MAIL)
    ? join(MAIL_SRC, spec.slice(MAIL.length))
    : join(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
};

const files = [...walk(SRC), ...walk(MAIL_SRC)];
const imports = new Map(
  files.map(file => [
    file,
    [
      ...readFileSync(file, 'utf8').matchAll(
        /(?:from\s*|\bimport\s*\(?\s*)'(\.\.?\/[^']+|@yozz\.app\/mail\/[^']+)'/g,
      ),
    ].flatMap(match => {
      const target = resolveImport(file, match[1] ?? '');
      return target === null ? [] : [target];
    }),
  ]),
);

/**
 * What a module needs before it can run: `import type` is erased and `import()` is a chunk of its
 * own, so neither is here. A bare specifier stays a package name, except a module of `@yozz.app/mail`.
 */
const staticImportsOf = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /^(?:(?:import|export)\s+(?!type\b)[\w$*{},\s]*?from\s*|import\s*)'([^']+)'/gm,
    ),
  ].flatMap(match => {
    const spec = match[1] ?? '';
    if (!spec.startsWith('.') && !spec.startsWith(MAIL)) return [spec];
    const target = resolveImport(file, spec);
    return target === null ? [] : [target];
  });
const rel = (file: string) =>
  file.startsWith(MAIL_SRC) ? `${MAIL}${relative(MAIL_SRC, file)}` : relative(SRC, file);
const folderOf = (file: string) => {
  if (file.startsWith(MAIL_SRC)) return 'mail';
  return rel(file).includes('/') ? (rel(file).split('/')[0] ?? '') : 'root';
};

describe('src/ folder rule', () => {
  it('has no import cycles between files', () => {
    const cycles = new Set<string>();
    // A file whose every path was walked has given up every cycle through it.
    const walked = new Set<string>();
    const visit = (file: string, stack: readonly string[]) => {
      const at = stack.indexOf(file);
      if (at !== -1) {
        cycles.add([...stack.slice(at), file].map(rel).join(' -> '));
        return;
      }
      if (walked.has(file)) return;
      for (const next of imports.get(file) ?? []) visit(next, [...stack, file]);
      walked.add(file);
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

describe('the entry chunk', () => {
  // DECISIONS.md, "A reload paints the shell, then the cache, and only then loads the TLS stack".
  // Routes count as reached: their code-splitting is the router plugin's, not a rule of ours.
  // The MIME parsers ride with it: either would put tens of kilobytes in front of the first paint.
  it('reaches the TLS stack and the MIME parsers only through import()', () => {
    const CONNECTION = join(SRC, 'relay/connection.ts');
    const STACK = /^(@yozz\.app\/(tls|x509|imap|smtp)|postal-mime|parse5)(?:\/.*)?$/;
    const reached = new Map<string, string[]>();
    const visit = (file: string) => {
      if (reached.has(file) || !file.startsWith('/')) return;
      const next = staticImportsOf(file);
      reached.set(file, next);
      for (const target of next) visit(target);
    };
    visit(join(SRC, 'main.tsx'));
    const named = (file: string) => (file.startsWith('/') ? rel(file) : file);
    const leaks = [...reached]
      .filter(([file]) => file !== CONNECTION)
      .flatMap(([file, targets]) =>
        targets
          .filter(target => target === CONNECTION || STACK.test(target))
          .map(target => `${named(file)} -> ${named(target)}`),
      );
    expect(leaks).toEqual([]);
  });
});
