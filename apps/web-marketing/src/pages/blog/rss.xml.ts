import type { APIRoute } from 'astro';
import { articleHref, BLOG_PATH, getArticles, renderRss } from '../../blog';

export const GET: APIRoute = async ({ site }) => {
  if (site === undefined) throw new Error('The feed needs `site` in astro.config.mjs');
  const articles = await getArticles();
  return new Response(
    renderRss({
      title: 'YOZZ Blog',
      description:
        'Updates and guides from YOZZ, a zero-knowledge webmail client over the mail accounts you already own.',
      siteUrl: site,
      feedPath: `${BLOG_PATH}/rss.xml`,
      homePath: BLOG_PATH,
      items: articles.map(article => ({
        title: article.data.heading,
        description: article.data.summary,
        path: articleHref(article),
        publishedOn: article.data.publishedOn,
      })),
    }),
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
  );
};
