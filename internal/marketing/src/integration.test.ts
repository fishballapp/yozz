import { describe, expect, it } from 'vitest';
import { findHeadProblems } from './integration';

const SITE = 'https://example.com';

const page = ({
  title = 'Page',
  description = 'About the page.',
  canonical,
  robots,
}: {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
}) =>
  [
    '<!doctype html><html><head>',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    ...(robots !== undefined ? [`<meta name="robots" content="${robots}">`] : []),
    ...(canonical !== undefined
      ? [
          `<link rel="canonical" href="${canonical}">`,
          `<meta property="og:url" content="${canonical}">`,
        ]
      : []),
    '</head><body><svg><title>Icon</title></svg></body></html>',
  ].join('');

describe('findHeadProblems', () => {
  it('passes pages whose canonical is the URL Workers serves them at', () => {
    expect(
      findHeadProblems({
        site: SITE,
        pages: [
          { file: 'index.html', html: page({ title: 'Home', canonical: `${SITE}/` }) },
          {
            file: 'privacy.html',
            html: page({ title: 'Privacy', description: 'Privacy.', canonical: `${SITE}/privacy` }),
          },
          { file: '404.html', html: page({ title: 'Not found', description: 'Gone.' }) },
          { file: 'og.html', html: page({ title: 'Card', robots: 'noindex' }) },
        ],
        sitemapUrls: [`${SITE}/`, `${SITE}/privacy`],
      }),
    ).toEqual([]);
  });

  it('catches a folder page canonicalised to the home page', () => {
    expect(
      findHeadProblems({
        site: SITE,
        pages: [{ file: 'privacy/index.html', html: page({ canonical: `${SITE}/` }) }],
        sitemapUrls: [`${SITE}/privacy/`],
      }),
    ).toEqual([
      `privacy/index.html wants one canonical equal to its served URL ${SITE}/privacy/, has "${SITE}/"`,
      `privacy/index.html wants og:url equal to ${SITE}/privacy/, has "${SITE}/"`,
    ]);
  });

  it('catches a folder page canonicalised to the form that redirects', () => {
    expect(
      findHeadProblems({
        site: SITE,
        pages: [{ file: 'privacy/index.html', html: page({ canonical: `${SITE}/privacy` }) }],
        sitemapUrls: [`${SITE}/privacy/`],
      }),
    ).toContain(
      `privacy/index.html wants one canonical equal to its served URL ${SITE}/privacy/, has "${SITE}/privacy"`,
    );
  });

  it('keeps the sitemap and the indexable pages the same set', () => {
    expect(
      findHeadProblems({
        site: SITE,
        pages: [
          { file: 'index.html', html: page({ canonical: `${SITE}/` }) },
          { file: 'draft.html', html: page({ title: 'Draft', robots: 'noindex, follow' }) },
        ],
        sitemapUrls: [`${SITE}/draft`, `${SITE}/gone`],
      }),
    ).toEqual([
      `index.html wants ${SITE}/ in the sitemap, or the Layout's isIndexable={false}`,
      'draft.html wants to stay out of the sitemap (not indexable)',
      `the sitemap lists ${SITE}/gone, which no built page is served at`,
    ]);
  });

  it('catches a missing title, a missing description and duplicates', () => {
    expect(
      findHeadProblems({
        site: SITE,
        pages: [
          { file: 'a.html', html: page({ title: ' ', description: '', canonical: `${SITE}/a` }) },
          { file: 'b.html', html: page({ title: 'Same', canonical: `${SITE}/b` }) },
          { file: 'c.html', html: page({ title: 'Same', canonical: `${SITE}/c` }) },
        ],
        sitemapUrls: [`${SITE}/a`, `${SITE}/b`, `${SITE}/c`],
      }),
    ).toEqual([
      'a.html wants one non-empty <title>, has " "',
      'a.html wants one non-empty meta description, has ""',
      'b.html, c.html share the title "Same"',
      'b.html, c.html share the description "About the page."',
    ]);
  });
});
