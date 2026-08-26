import type { Plugin } from 'vite';

export const withoutHtmlComments = (html: string): string =>
  html.replace(/\s*<!--[\s\S]*?-->/g, '');

/**
 * Comments in an app's `index.html` are notes to us, not to whoever views source on the live
 * site. Vite copies them into `dist/index.html` verbatim, so this removes every one at build time;
 * the source file keeps them. Dev mode is untouched.
 *
 * A regex rather than a minifier: Vite, Rolldown and Oxc have no HTML pass, `html-minifier-terser`
 * and `vite-plugin-html` last shipped in 2023/2024 and target Vite 4, and `@swc/html` is a native
 * binary for a job on one 25-line file we author. The known ceiling is HTML we did not write: a
 * `<!--` inside an inline `<script>` string would be eaten to the next `-->`.
 */
export const stripHtmlComments = (): Plugin => ({
  name: 'fishballapps:strip-html-comments',
  apply: 'build',
  transformIndexHtml: withoutHtmlComments,
});
