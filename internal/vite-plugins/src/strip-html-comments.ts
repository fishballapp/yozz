import type { Plugin } from 'vite';

export const withoutHtmlComments = (html: string): string =>
  html.replace(/\s*<!--[\s\S]*?-->/g, '');

/**
 * Strips comments from `dist/index.html` at build time; dev mode and the source are untouched.
 * A regex, since no bundler here has an HTML pass: a `<!--` inside an inline `<script>` string
 * would be eaten to the next `-->`.
 */
export const stripHtmlComments = (): Plugin => ({
  name: 'fishballapps:strip-html-comments',
  apply: 'build',
  transformIndexHtml: withoutHtmlComments,
});
