#!/usr/bin/env node
/**
 * Puts the app (@yozz.app/web) and the landing page (@yozz.app/web-marketing) into dist/, the one
 * assets directory wrangler.jsonc serves. The app's files keep their paths, so every app URL is
 * served as it was; the landing's index.html becomes _landing.html, which src/index.ts answers
 * `/` with for a browser that is not signed in. The app's _headers covers both, and the Worker adds
 * PostHog's ingest host to the landing page's connect-src.
 *
 * It refuses a build that would run a script the origin did not ship: an inline one, one from
 * another host, or (in the landing page, which carries PostHog) code that loads one. In the
 * landing build only the landing page may run a script at all: its response alone gets PostHog's
 * host, and the policies beside it (`/privacy`, `/terms`) carry no analytics.
 *
 * Both builds must exist: `pnpm -F @yozz.app/worker-web run deploy` makes them first.
 * `--allow-missing` (for `wrangler dev`, which only needs the directory) assembles whatever is built.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(packageDir, 'dist');
const isMissingAllowed = process.argv.includes('--allow-missing');

/**
 * Each build that goes in, the files it puts under another name, whether its code may create a
 * <script> element, and which of its pages may run a script (`null`: any). React DOM in the app
 * creates scripts; the landing page's code never needs to, and its PostHog must not (DECISIONS.md,
 * "Analytics on the landing page only"). Of the landing build's pages only the landing page runs
 * one, because only its response may reach PostHog (DECISIONS.md, "The policies at /privacy and
 * /terms carry no analytics").
 */
const sources: readonly {
  name: string;
  dir: string;
  rename: Readonly<Record<string, string>>;
  canCreateScripts: boolean;
  pagesWithScripts: readonly string[] | null;
}[] = [
  {
    name: '@yozz.app/web',
    dir: path.resolve(packageDir, '../web/dist'),
    rename: {},
    canCreateScripts: true,
    pagesWithScripts: null,
  },
  {
    name: '@yozz.app/web-marketing',
    dir: path.resolve(packageDir, '../web-marketing/dist'),
    rename: { 'index.html': '_landing.html' },
    canCreateScripts: false,
    pagesWithScripts: ['index.html'],
  },
];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)));

/**
 * The origin's CSP (apps/web/public/_headers) lets no inline script run. A build that inlines one
 * would ship a page whose script silently never runs, so it stops here instead. JSON-LD is data,
 * which no CSP governs.
 */
const inlineScriptsIn = (html: string): string[] =>
  [...html.matchAll(/<script\b([^>]*)>/g)]
    .map(([tag, attributes = '']) => ({ tag, attributes }))
    .filter(({ attributes }) => !/\ssrc=/.test(attributes))
    .filter(({ attributes }) => !/\stype="application\/ld\+json"/.test(attributes))
    .map(({ tag }) => tag);

/**
 * Every <script src> that is not a path on this origin. The CSP would block it, and a reader of
 * the build should not have to work out which host it meant.
 */
const foreignScriptsIn = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)]
    .map(([, src = '']) => src)
    .filter(src => !src.startsWith('/') || src.startsWith('//'));

/**
 * Code that would fetch a script and run it: a <script> element made at runtime, or PostHog's
 * remote loader registering itself. The landing page's posthog-js is the build with neither, and
 * this is what notices if an import or a version bump brings one back.
 */
const SCRIPT_LOADERS = [
  /createElement\(\s*["'`]script["'`]\s*\)/i,
  /loadExternalDependency\s*=(?!=)/,
];

const scriptLoadersIn = (dir: string): string[] =>
  filesUnder(dir)
    .filter(file => file.endsWith('.js'))
    .filter(file => {
      const text = readFileSync(path.join(dir, file), 'utf8');
      return SCRIPT_LOADERS.some(pattern => pattern.test(text));
    });

/**
 * Scripts a build emitted that no page or script names: a file on this origin that nothing runs
 * says something untrue to a reader checking the build against the code.
 */
const unusedScriptsIn = (dir: string): string[] => {
  const loaders = filesUnder(dir)
    .filter(file => /\.(html|js)$/.test(file))
    .map(file => ({ file, text: readFileSync(path.join(dir, file), 'utf8') }));
  return loaders
    .filter(({ file }) => file.endsWith('.js'))
    .filter(({ file }) =>
      loaders.every(other => other.file === file || !other.text.includes(path.basename(file))),
    )
    .map(({ file }) => file);
};

/** Every page of a build that runs a script, JSON-LD aside, which is data. */
const pagesRunningScriptsIn = (dir: string): string[] =>
  filesUnder(dir)
    .filter(file => file.endsWith('.html'))
    .filter(file =>
      [...readFileSync(path.join(dir, file), 'utf8').matchAll(/<script\b([^>]*)>/g)].some(
        ([, attributes = '']) => !/\stype="application\/ld\+json"/.test(attributes),
      ),
    );

const built = sources.filter(source => {
  if (existsSync(path.join(source.dir, 'index.html'))) return true;
  const message = `${source.name} is not built (no ${path.relative(packageDir, source.dir)}/index.html). Run \`pnpm -F ${source.name} build\`.`;
  if (!isMissingAllowed) throw new Error(message);
  console.warn(`Skipping: ${message}`);
  return false;
});

const unusedScripts = built.flatMap(({ name, dir }) =>
  unusedScriptsIn(dir).map(file => `${name}: ${file}`),
);
if (unusedScripts.length > 0) {
  throw new Error(`Scripts in a build that nothing loads:\n${unusedScripts.join('\n')}`);
}

const scriptLoaders = built
  .filter(({ canCreateScripts }) => !canCreateScripts)
  .flatMap(({ name, dir }) => scriptLoadersIn(dir).map(file => `${name}: ${file}`));
if (scriptLoaders.length > 0) {
  throw new Error(
    `Code that loads a script, in a build that must not:\n${scriptLoaders.join('\n')}`,
  );
}

const scriptedPages = built.flatMap(({ name, dir, pagesWithScripts }) =>
  pagesWithScripts === null
    ? []
    : pagesRunningScriptsIn(dir)
        .filter(file => !pagesWithScripts.includes(file))
        .map(file => `${name}: ${file}`),
);
if (scriptedPages.length > 0) {
  throw new Error(
    `Pages that run a script in a build that allows one only on its landing page, whose response alone may reach PostHog:\n${scriptedPages.join('\n')}`,
  );
}

const placed = new Map<string, string>();
const copies = built.flatMap(({ name, dir, rename }) =>
  filesUnder(dir).map(file => {
    const target = rename[file] ?? file;
    const earlier = placed.get(target);
    if (earlier !== undefined) {
      throw new Error(`${name} and ${earlier} both have ${target}; one of them must rename it.`);
    }
    placed.set(target, name);
    return { from: path.join(dir, file), to: path.join(out, target) };
  }),
);

const inlineScripts = copies
  .filter(({ to }) => to.endsWith('.html'))
  .flatMap(({ from, to }) =>
    inlineScriptsIn(readFileSync(from, 'utf8')).map(tag => `${path.relative(out, to)}: ${tag}`),
  );
if (inlineScripts.length > 0) {
  throw new Error(
    `Inline scripts, which the CSP in apps/web/public/_headers blocks:\n${inlineScripts.join('\n')}`,
  );
}

const foreignScripts = copies
  .filter(({ to }) => to.endsWith('.html'))
  .flatMap(({ from, to }) =>
    foreignScriptsIn(readFileSync(from, 'utf8')).map(src => `${path.relative(out, to)}: ${src}`),
  );
if (foreignScripts.length > 0) {
  throw new Error(`Scripts from another host, which the CSP blocks:\n${foreignScripts.join('\n')}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const { from, to } of copies) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}
console.log(
  `Assembled ${copies.length} files from ${built.map(({ name }) => name).join(' and ') || 'nothing'} into dist/.`,
);
