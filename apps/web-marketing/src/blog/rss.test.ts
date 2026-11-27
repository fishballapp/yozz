import { describe, expect, it } from 'vitest';
import { escapeXml, renderRss, rfc822Date } from './rss';

describe('escapeXml', () => {
  it('escapes the five characters XML reserves, and leaves the rest', () => {
    expect(escapeXml(`Tom & Jerry's <"mail">`)).toBe(
      'Tom &amp; Jerry&apos;s &lt;&quot;mail&quot;&gt;',
    );
    expect(escapeXml('Send-as · 993 → 465')).toBe('Send-as · 993 → 465');
  });

  it('escapes an ampersand that already looks like an entity', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });
});

describe('rfc822Date', () => {
  it('is the day at midnight UTC, with English day and month names', () => {
    expect(rfc822Date('2026-11-27')).toBe('Fri, 27 Nov 2026 00:00:00 +0000');
    expect(rfc822Date('2027-01-03')).toBe('Sun, 03 Jan 2027 00:00:00 +0000');
    expect(rfc822Date('2024-02-29')).toBe('Thu, 29 Feb 2024 00:00:00 +0000');
  });

  it('refuses a string that is not a calendar day', () => {
    expect(() => rfc822Date('27 November 2026')).toThrow();
  });
});

describe('renderRss', () => {
  const feed = renderRss({
    title: 'YOZZ Blog',
    description: 'Updates & guides',
    siteUrl: 'https://yozz.app',
    feedPath: '/blog/rss.xml',
    homePath: '/blog',
    items: [
      {
        title: 'Introducing <YOZZ>',
        description: 'One inbox & send-as',
        path: '/blog/introducing-yozz',
        publishedOn: '2026-11-27',
      },
    ],
  });

  it('is an RSS 2.0 channel that names its own URL', () => {
    expect(feed).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0" /);
    expect(feed).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
    expect(feed).toContain(
      '<atom:link href="https://yozz.app/blog/rss.xml" rel="self" type="application/rss+xml" />',
    );
    expect(feed).toContain('<link>https://yozz.app/blog</link>');
    expect(feed).toContain('<description>Updates &amp; guides</description>');
  });

  it('writes each item with absolute links, escaped text and an RFC 822 date', () => {
    expect(feed).toContain(
      [
        '    <item>',
        '      <title>Introducing &lt;YOZZ&gt;</title>',
        '      <link>https://yozz.app/blog/introducing-yozz</link>',
        '      <guid isPermaLink="true">https://yozz.app/blog/introducing-yozz</guid>',
        '      <description>One inbox &amp; send-as</description>',
        '      <pubDate>Fri, 27 Nov 2026 00:00:00 +0000</pubDate>',
        '    </item>',
      ].join('\n'),
    );
  });

  it('is a channel with no items when there are no articles', () => {
    const empty = renderRss({
      title: 'YOZZ Blog',
      description: 'Updates',
      siteUrl: 'https://yozz.app',
      feedPath: '/blog/rss.xml',
      homePath: '/blog',
      items: [],
    });
    expect(empty).not.toContain('<item>');
    expect(empty).toContain('</channel>');
  });
});
