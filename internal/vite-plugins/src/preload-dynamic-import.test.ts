import type { IndexHtmlTransformContext } from 'vite';
import { describe, expect, it } from 'vitest';
import { preloadTags } from './preload-dynamic-import';

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>;

const chunk = (
  fileName: string,
  {
    facadeModuleId = null,
    imports = [],
    css = [],
  }: { facadeModuleId?: string | null; imports?: string[]; css?: string[] } = {},
) => ({
  type: 'chunk',
  fileName,
  facadeModuleId,
  imports,
  viteMetadata: { importedCss: new Set(css), importedAssets: new Set<string>() },
});

const bundle = {
  'assets/index.js': chunk('assets/index.js', { facadeModuleId: '/repo/index.html' }),
  'assets/app.js': chunk('assets/app.js', {
    facadeModuleId: '/repo/src/app.tsx',
    imports: ['assets/react.js', 'assets/router.js'],
    css: ['assets/app.css'],
  }),
  'assets/router.js': chunk('assets/router.js', { imports: ['assets/react.js'] }),
  'assets/react.js': chunk('assets/react.js'),
  'assets/polyfill.js': chunk('assets/polyfill.js'),
  'assets/app.css': { type: 'asset', fileName: 'assets/app.css' },
} as unknown as Bundle;

const hrefs = (rel: string) =>
  preloadTags(bundle, '/src/app.tsx', '/')
    .filter(tag => tag.attrs?.rel === rel)
    .map(tag => tag.attrs?.href);

describe('preloadTags', () => {
  it('preloads the module, what it imports statically, and nothing else', () => {
    expect(hrefs('modulepreload')).toEqual([
      '/assets/app.js',
      '/assets/react.js',
      '/assets/router.js',
    ]);
  });

  it('links the stylesheets those chunks import', () => {
    expect(hrefs('stylesheet')).toEqual(['/assets/app.css']);
  });

  it('fails the build when the module is not in it', () => {
    expect(() => preloadTags(bundle, '/src/missing.tsx', '/')).toThrow('/src/missing.tsx');
  });
});
