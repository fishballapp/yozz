import { getCollection } from 'astro:content';
import { nextArticle, sortArticles } from './articles';

/** Every article in the site's `blog` collection (`src/content.config.ts`), newest first. */
export const getArticles = async () => sortArticles(await getCollection('blog'));

/** The article to read after this one, or `null` while it is the only one. */
export const getNextArticle = async (article: { id: string }) =>
  nextArticle(await getArticles(), article);
