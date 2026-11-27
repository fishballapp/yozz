import { z } from 'astro/zod';

/** The frontmatter every article has (`src/content.config.ts`). */
export const blogFields = {
  /** The `<title>`, verbatim: the site's name is on the end unless the title already names it. */
  title: z.string(),
  description: z.string(),
  /** The question or claim the article answers, as its one `<h1>`. */
  heading: z.string(),
  /** One line for the blog index, the feed and "Read next". */
  summary: z.string(),
  /**
   * The search the article is written to answer, as people type it. Never rendered: the blog
   * routine compares it with the queries Search Console shows for the page.
   */
  targetQuery: z.string().optional(),
  /** The day it went up. YAML reads an unquoted `2026-11-27` as a date, so both forms pass. */
  publishedOn: z.union([z.date().transform(date => date.toISOString().slice(0, 10)), z.iso.date()]),
  /** An `update` is dated news; a `guide` answers one search and says so beside its date. */
  kind: z.enum(['update', 'guide']).default('update'),
  /** A guide's short answer, one paragraph per item, shown above the article with its action. */
  answer: z.array(z.string()).min(1).optional(),
  /** The label of the button under `answer`, where a narrower verb fits than the default. */
  actionLabel: z.string().optional(),
};
