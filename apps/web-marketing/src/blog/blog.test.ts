import { describe, expect, it } from 'vitest';
import { articleHref, nextArticle, sortArticles } from './articles';
import { blogPosting } from './json-ld';

const article = (id: string, publishedOn: string) => ({ id, data: { publishedOn } });

describe('sortArticles', () => {
  it('puts the newest first, and same-day articles in reverse slug order', () => {
    const sorted = sortArticles([
      article('a', '2026-11-27'),
      article('old', '2026-10-01'),
      article('b', '2026-11-27'),
    ]);
    expect(sorted.map(({ id }) => id)).toEqual(['b', 'a', 'old']);
  });
});

describe('nextArticle', () => {
  it('is null while there is only one article, so it never links to itself', () => {
    expect(
      nextArticle([article('introducing-yozz', '2026-11-27')], { id: 'introducing-yozz' }),
    ).toBe(null);
  });

  it('is the next older article, wrapping from the oldest back to the newest', () => {
    const articles = [
      article('c', '2026-12-03'),
      article('b', '2026-12-02'),
      article('a', '2026-12-01'),
    ];
    expect(nextArticle(articles, { id: 'c' })?.id).toBe('b');
    expect(nextArticle(articles, { id: 'b' })?.id).toBe('a');
    expect(nextArticle(articles, { id: 'a' })?.id).toBe('c');
  });

  it('refuses an article that is not in the list', () => {
    expect(() =>
      nextArticle([article('a', '2026-12-01'), article('b', '2026-12-02')], { id: 'x' }),
    ).toThrow(/not one of the articles/);
  });
});

describe('blogPosting', () => {
  it("is the article's BlogPosting, at its absolute URL", () => {
    expect(
      blogPosting({
        article: {
          id: 'introducing-yozz',
          data: {
            heading: 'Introducing YOZZ',
            description: 'A client.',
            publishedOn: '2026-11-27',
          },
        },
        siteUrl: 'https://yozz.app',
        publisher: { name: 'YOZZ', url: 'https://yozz.app/' },
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Introducing YOZZ',
      description: 'A client.',
      datePublished: '2026-11-27',
      url: 'https://yozz.app/blog/introducing-yozz',
      publisher: { '@type': 'Organization', name: 'YOZZ', url: 'https://yozz.app/' },
    });
  });

  it('builds the URL from the blog path', () => {
    expect(articleHref({ id: 'introducing-yozz' })).toBe('/blog/introducing-yozz');
  });
});
