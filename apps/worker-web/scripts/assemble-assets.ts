#!/usr/bin/env node
/**
 * Puts the app (@yozz.app/web) and the landing page (@yozz.app/web-marketing) into dist/, the one
 * assets directory wrangler.jsonc serves. The app's files keep their paths, so every app URL is
 * served as it was; the landing's index.html becomes _landing.html, which src/index.ts answers
 * `/` with for a browser that is not signed in. The app's _headers covers both, and the Worker adds
 * PostHog's ingest host to the landing page's and the blog's connect-src.
 *
 * It refuses a build that would run a script the origin did not ship: an inline one, one from
 * another host, or (in the landing build, which carries PostHog) code that loads one. In the
 * landing build only the landing page and the blog may run a script at all: their responses alone
 * get PostHog's host, and the pages beside them (`/privacy`, `/terms`, the 404 page) carry no
 * analytics.
 *
 * It also writes `_blog-manifest.json`, the blog's served paths, from which the Worker tells a
 * blog page from a blog file from an address that does not exist (a 404, not the app's shell).
 *
 * Both builds must exist: `pnpm -F @yozz.app/worker-web run deploy` makes them first.
 * `--allow-missing` (for `wrangler dev`, which only needs the directory) assembles whatever is built.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(packageDir, 'dist');
const isMissingAllowed = process.argv.includes('--allow-missing');
const MARKETING = '@yozz.app/web-marketing';
/** Read by src/blog.ts, which names the same file. */
const BLOG_MANIFEST = '_blog-manifest.json';

/** The blog's pages and files in the landing build, as paths under its dist/. */
const isBlogFile = (file: string): boolean => file === 'blog.html' || file.startsWith('blog/');

/**
 * Each build that goes in, the files it puts under another name, whether its code may create a
 * <script> element, and which of its pages may run a script (`null`: any). React DOM in the app
 * creates scripts; the landing page's code never needs to, and its PostHog must not (DECISIONS.md,
 * "Analytics on the landing page only"). Of the landing build's pages only the landing page and
 * the blog run one, because only their responses may reach PostHog (DECISIONS.md, "The policies
 * at /privacy and /terms carry no analytics").
 */
const sources: readonly {
  name: string;
  dir: string;
  rename: Readonly<Record<string, string>>;
  canCreateScripts: boolean;
  canRunScripts: ((page: string) => boolean) | null;
}[] = [
  {
    name: '@yozz.app/web',
    dir: path.resolve(packageDir, '../web/dist'),
    rename: {},
    canCreateScripts: true,
    canRunScripts: null,
  },
  {
    name: MARKETING,
    dir: path.resolve(packageDir, '../web-marketing/dist'),
    rename: { 'index.html': '_landing.html' },
    canCreateScripts: false,
    canRunScripts: page => page === 'index.html' || isBlogFile(page),
  },
];

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    );

const isJsonLdScript = (attributes: string): boolean =>
  /\stype=(?:"application\/ld\+json"|'application\/ld\+json')/i.test(attributes);

/**
 * The origin's CSP (apps/web/public/_headers) lets no inline script run. A build that inlines one
 * would ship a page whose script silently never runs, so it stops here instead. JSON-LD is data,
 * which no CSP governs.
 */
const inlineScriptsIn = (html: string): string[] =>
  [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map(([tag, attributes = '']) => ({ tag, attributes }))
    .filter(({ attributes }) => !/\ssrc\s*=/i.test(attributes))
    .filter(({ attributes }) => !isJsonLdScript(attributes))
    .map(({ tag }) => tag);

/**
 * Every <script src> that is not a path on this origin. The CSP would block it, and a reader of
 * the build should not have to work out which host it meant.
 */
const foreignScriptsIn = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map(([, doubleQuoted, singleQuoted]) => doubleQuoted ?? singleQuoted ?? '')
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
      [...readFileSync(path.join(dir, file), 'utf8').matchAll(/<script\b([^>]*)>/gi)].some(
        ([, attributes = '']) => !isJsonLdScript(attributes),
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

const scriptedPages = built.flatMap(({ name, dir, canRunScripts }) =>
  canRunScripts === null
    ? []
    : pagesRunningScriptsIn(dir)
        .filter(file => !canRunScripts(file))
        .map(file => `${name}: ${file}`),
);
if (scriptedPages.length > 0) {
  throw new Error(
    `Pages that run a script in a build that allows one only on its landing page and blog, whose responses alone may reach PostHog:\n${scriptedPages.join('\n')}`,
  );
}

/**
 * The blog's served paths: each page at its address without `.html` (as the assets layer serves
 * it), each other file (the feed) at its own. Empty while the landing build is missing, so the
 * Worker answers every blog address with a 404.
 */
const blogManifest = (() => {
  const marketing = built.find(({ name }) => name === MARKETING);
  if (marketing === undefined) return { html: [], assets: [] };
  if (!existsSync(path.join(marketing.dir, '404.html'))) {
    throw new Error(
      `${MARKETING} has no 404.html, which the Worker answers an unknown blog address with.`,
    );
  }
  const files = filesUnder(marketing.dir)
    .filter(isBlogFile)
    .map(file => `/${file}`)
    .toSorted();
  return {
    html: files.filter(file => file.endsWith('.html')).map(file => file.replace(/\.html$/, '')),
    assets: files.filter(file => !file.endsWith('.html')),
  };
})();

const placed = new Map<string, string>();
const copies = built.flatMap(({ name, dir, rename }) =>
  filesUnder(dir).map(file => {
    const target = rename[file] ?? file;
    const earlier = placed.get(target);
    if (earlier !== undefined) {
      throw new Error(`${name} and ${earlier} both have ${target}; one of them must rename it.`);
    }
    if (target === BLOG_MANIFEST) {
      throw new Error(`${name} has ${target}, which this script writes.`);
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
writeFileSync(path.join(out, BLOG_MANIFEST), `${JSON.stringify(blogManifest, null, 2)}\n`);
console.log(
  `Assembled ${copies.length} files from ${built.map(({ name }) => name).join(' and ') || 'nothing'} into dist/.`,
);
