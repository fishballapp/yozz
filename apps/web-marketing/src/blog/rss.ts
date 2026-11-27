const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Text safe inside an XML element or a quoted attribute. */
export const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, character => XML_ESCAPES[character] ?? character);

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar day as RSS 2.0's RFC 822 date, at midnight UTC: `Fri, 27 Nov 2026 00:00:00 +0000`.
 * The names are RFC 822's own, never a locale's.
 */
export const rfc822Date = (isoDate: string): string => {
  const date = Temporal.PlainDate.from(isoDate);
  const day = String(date.day).padStart(2, '0');
  return `${WEEKDAYS[date.dayOfWeek - 1]}, ${day} ${MONTHS[date.month - 1]} ${date.year} 00:00:00 +0000`;
};

export type FeedItem = {
  title: string;
  description: string;
  /** The item's path on the site, e.g. `/blog/introducing-yozz`. */
  path: string;
  /** ISO calendar day, e.g. `2026-11-27`. */
  publishedOn: string;
};

/** An RSS 2.0 feed of `items`, in the order given, with absolute links resolved from `siteUrl`. */
export const renderRss = ({
  title,
  description,
  siteUrl,
  feedPath,
  homePath,
  items,
}: {
  title: string;
  description: string;
  siteUrl: string | URL;
  /** Where the feed itself is served, for its `atom:link rel="self"`. */
  feedPath: string;
  /** The page the feed is the feed of. */
  homePath: string;
  items: readonly FeedItem[];
}): string => {
  const url = (path: string) => escapeXml(new URL(path, siteUrl).href);
  const entries = items.map(item =>
    [
      '    <item>',
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${url(item.path)}</link>`,
      `      <guid isPermaLink="true">${url(item.path)}</guid>`,
      `      <description>${escapeXml(item.description)}</description>`,
      `      <pubDate>${rfc822Date(item.publishedOn)}</pubDate>`,
      '    </item>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${url(homePath)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    '    <language>en-GB</language>',
    `    <atom:link href="${url(feedPath)}" rel="self" type="application/rss+xml" />`,
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
};
