import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>;

/**
 * The `<link>` tags that make the browser fetch a dynamically imported module with the page: the
 * module's chunk, every chunk it imports statically, and their stylesheets.
 */
export const preloadTags = (
  bundle: Bundle,
  moduleId: string,
  base: string,
): readonly HtmlTagDescriptor[] => {
  const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
  const root = chunks.find(chunk => chunk.facadeModuleId?.endsWith(moduleId));
  if (root === undefined) {
    throw new Error(`preloadDynamicImport: no chunk in the build is the module "${moduleId}"`);
  }
  const byFileName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const reached = new Set([root]);
  for (const chunk of reached) {
    for (const fileName of chunk.imports) {
      const imported = byFileName.get(fileName);
      if (imported !== undefined) reached.add(imported);
    }
  }
  const stylesheets = new Set(
    [...reached].flatMap(chunk => [...(chunk.viteMetadata?.importedCss ?? [])]),
  );
  return [
    ...[...reached].map(chunk => ({
      tag: 'link',
      attrs: { rel: 'modulepreload', crossorigin: true, href: `${base}${chunk.fileName}` },
      injectTo: 'head' as const,
    })),
    ...[...stylesheets].map(fileName => ({
      tag: 'link',
      attrs: { rel: 'stylesheet', crossorigin: true, href: `${base}${fileName}` },
      injectTo: 'head' as const,
    })),
  ];
};

/**
 * Preloads a module the entry imports dynamically, so the browser fetches it with the page
 * instead of after the entry has run. For an entry that must finish something first (load a
 * polyfill) before it imports the app. `moduleId` is the end of the module's path
 * (`/src/app.tsx`).
 */
export const preloadDynamicImport = (moduleId: string): Plugin => {
  let base = '/';
  return {
    name: 'fishballapps:preload-dynamic-import',
    apply: 'build',
    configResolved: config => {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html, { bundle }) =>
        bundle === undefined
          ? []
          : preloadTags(bundle, moduleId, base).filter(
              // Vite already preloads what the entry itself imports statically.
              tag => typeof tag.attrs?.href !== 'string' || !html.includes(tag.attrs.href),
            ),
    },
  };
};
