/** Where the blog lives. Its route file is `src/pages/blog/[slug].astro`, so they move together. */
export const BLOG_PATH = '/blog';

type Dated = { id: string; data: { publishedOn: string } };

/** Newest first; same-day articles in reverse order of their slugs, so the order is total. */
export const sortArticles = <Article extends Dated>(articles: readonly Article[]): Article[] =>
  articles.toSorted(
    (a, b) => b.data.publishedOn.localeCompare(a.data.publishedOn) || b.id.localeCompare(a.id),
  );

export const articleHref = ({ id }: { id: string }): string => `${BLOG_PATH}/${id}`;

/**
 * The article after `id` in `articles` (sorted), wrapping from the last to the first. `null` when
 * there is no other article, so a lone article never links to itself.
 */
export const nextArticle = <Article extends { id: string }>(
  articles: readonly Article[],
  { id }: { id: string },
): Article | null => {
  if (articles.length <= 1) return null;
  const index = articles.findIndex(article => article.id === id);
  if (index === -1) throw new Error(`"${id}" is not one of the articles`);
  const next = articles[(index + 1) % articles.length];
  if (next === undefined) throw new Error(`No article follows "${id}"`);
  return next;
};
