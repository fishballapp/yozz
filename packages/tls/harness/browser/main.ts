// WebKit has no native Temporal, so this page installs the polyfill the README asks of a caller
// where the runtime has none, before any module that reads `Temporal` is evaluated.
if (!('Temporal' in globalThis)) await import('temporal-polyfill/global');
await import('./page.ts');

export {};
