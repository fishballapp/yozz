import { articleHref } from './articles';

/** The article's `BlogPosting` for Google, as the `structuredData` of its page. */
export const blogPosting = ({
  article,
  siteUrl,
  publisher,
}: {
  article: { id: string; data: { heading: string; description: string; publishedOn: string } };
  siteUrl: string | URL;
  publisher: { name: string; url: string };
}) => ({
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: article.data.heading,
  description: article.data.description,
  datePublished: article.data.publishedOn,
  url: new URL(articleHref(article), siteUrl).href,
  publisher: { '@type': 'Organization', ...publisher },
});
