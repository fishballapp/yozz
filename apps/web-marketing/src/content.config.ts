import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { blogFields } from './blog';

// An article is one file here: `src/content/blog/<slug>.md`, or `.mdx` when it needs a component.
// Its frontmatter is what /blog, the feed, "Read next" and the article's own head read, so a
// missing or mistyped field fails the build.
const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '*.{md,mdx}' }),
  schema: z.object(blogFields),
});

export const collections = { blog };
