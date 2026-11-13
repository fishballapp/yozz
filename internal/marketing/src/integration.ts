import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { parse } from 'node-html-parser';

export type BuiltPage = {
  // Path of the built HTML file inside the output directory, '/'-separated ("about.html").
  file: string;
  html: string;
};

// Workers Static Assets (`auto-trailing-slash`) serves "about.html" at "/about", "index.html" at
// "/" and "docs/index.html" at "/docs/"; the other forms answer 307 to these.
const toServedPath = (file: string): string =>
  `/${file.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;

// "https://a.com" and "https://a.com/" are one URL; a relative one stays as written, and fails.
const normalizeUrl = (url: string): string => (URL.canParse(url) ? new URL(url).href : url);

const quoted = (values: string[]): string =>
  values.length === 0 ? 'none' : values.map(value => JSON.stringify(value)).join(', ');

const isOneNonEmpty = (values: string[]): boolean =>
  values.length === 1 && values[0]?.trim() !== '';

const readHead = ({ file, html }: BuiltPage, site: string) => {
  const head = parse(html).querySelector('head');
  const attributes = (selector: string, attribute: string): string[] =>
    (head?.querySelectorAll(selector) ?? []).map(element => element.getAttribute(attribute) ?? '');
  const url = new URL(toServedPath(file), site).href;
  return {
    file,
    url,
    // The 404 page answers 404 at every URL it is served for, so it is never indexed.
    isIndexable:
      file !== '404.html' &&
      !attributes('meta[name="robots"]', 'content').some(content => /\bnoindex\b/i.test(content)),
    titles: (head?.querySelectorAll('title') ?? []).map(title => title.textContent),
    descriptions: attributes('meta[name="description"]', 'content'),
    canonicals: attributes('link[rel="canonical"]', 'href').map(normalizeUrl),
    ogUrls: attributes('meta[property="og:url"]', 'content').map(normalizeUrl),
  };
};

const findDuplicates = <T>(items: T[], keyOf: (item: T) => string | undefined) =>
  [...Map.groupBy(items, keyOf)].filter(
    ([key, group]) => key !== undefined && key !== '' && group.length > 1,
  );

/** Every way the built pages' heads and the sitemap disagree with the URLs that will serve them. */
export const findHeadProblems = ({
  site,
  pages,
  sitemapUrls,
}: {
  site: string;
  pages: BuiltPage[];
  sitemapUrls: string[];
}): string[] => {
  const heads = pages.map(page => readHead(page, site));
  const sitemap = new Set(sitemapUrls);
  const servedUrls = new Set(heads.map(head => head.url));
  const indexable = heads.filter(head => head.isIndexable);

  return [
    ...heads.flatMap(head =>
      [
        {
          isMet: isOneNonEmpty(head.titles),
          wants: `one non-empty <title>, has ${quoted(head.titles)}`,
        },
        ...(head.isIndexable
          ? [
              {
                isMet: isOneNonEmpty(head.descriptions),
                wants: `one non-empty meta description, has ${quoted(head.descriptions)}`,
              },
              {
                isMet: head.canonicals.length === 1 && head.canonicals[0] === head.url,
                wants: `one canonical equal to its served URL ${head.url}, has ${quoted(head.canonicals)}`,
              },
              {
                isMet: head.ogUrls.every(ogUrl => ogUrl === head.url),
                wants: `og:url equal to ${head.url}, has ${quoted(head.ogUrls)}`,
              },
              {
                isMet: sitemap.has(head.url),
                wants: `${head.url} in the sitemap, or the Layout's isIndexable={false}`,
              },
            ]
          : [
              {
                isMet: !sitemap.has(head.url),
                wants: `to stay out of the sitemap (not indexable)`,
              },
            ]),
      ]
        .filter(({ isMet }) => !isMet)
        .map(({ wants }) => `${head.file} wants ${wants}`),
    ),
    ...sitemapUrls
      .filter(url => !servedUrls.has(url))
      .map(url => `the sitemap lists ${url}, which no built page is served at`),
    ...findDuplicates(indexable, head => head.titles[0]).map(
      ([title, group]) => `${group.map(head => head.file).join(', ')} share the title "${title}"`,
    ),
    ...findDuplicates(indexable, head => head.descriptions[0]).map(
      ([description, group]) =>
        `${group.map(head => head.file).join(', ')} share the description "${description}"`,
    ),
  ];
};

const readLocs = async (file: URL): Promise<string[]> =>
  parse(await readFile(file, 'utf8'))
    .querySelectorAll('loc')
    .map(loc => loc.textContent.trim());

/** Every page URL in the `@astrojs/sitemap` output under `dir`. */
export const readSitemapUrls = async (dir: URL): Promise<string[]> => {
  const index = new URL('sitemap-index.xml', dir);
  if (!existsSync(index)) {
    throw new Error(
      `@internal/marketing: no sitemap-index.xml in ${fileURLToPath(dir)}; list sitemap() before marketing() in integrations`,
    );
  }
  const sitemaps = await readLocs(index);
  const urls = await Promise.all(
    sitemaps.map(sitemap => readLocs(new URL(`.${new URL(sitemap).pathname}`, dir))),
  );
  return urls.flat();
};

/**
 * The marketing stack's Astro integration: requires the one URL shape the Layout's canonical
 * assumes (`site`, `build.format: 'file'`, `trailingSlash: 'never'`), and fails the build when a
 * page's head or the sitemap is wrong. List it after `sitemap()`, whose output it reads.
 */
export const marketing = (): AstroIntegration => {
  // Set by astro:config:done, read by astro:build:done.
  let site: string | undefined;
  return {
    name: '@internal/marketing',
    hooks: {
      'astro:config:done': ({ config }) => {
        if (
          config.site === undefined ||
          config.build.format !== 'file' ||
          config.trailingSlash !== 'never'
        ) {
          throw new Error(
            "@internal/marketing: astro.config needs `site`, `build: { format: 'file' }` and `trailingSlash: 'never'`",
          );
        }
        site = config.site;
      },
      'astro:build:done': async ({ dir, assets, logger }) => {
        if (site === undefined) {
          throw new Error('@internal/marketing: astro:config:done never ran');
        }
        const pages = await Promise.all(
          [...assets.values()]
            .flat()
            .filter(file => file.pathname.endsWith('.html'))
            .map(async file => ({
              file: relative(fileURLToPath(dir), fileURLToPath(file)),
              html: await readFile(file, 'utf8'),
            })),
        );
        const problems = findHeadProblems({ site, pages, sitemapUrls: await readSitemapUrls(dir) });
        if (problems.length > 0) {
          throw new Error(
            `@internal/marketing: broken page heads\n${problems.map(problem => `  - ${problem}`).join('\n')}`,
          );
        }
        logger.info(`${pages.length} page heads match their served URLs and the sitemap`);
      },
    },
  };
};
