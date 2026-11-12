import { expect, it } from 'vitest';
import entry from '../src/index.ts?raw';
import { nativeTemporal } from '../src/temporal.ts';

const sources = import.meta.glob<string>(['../src/**/*.ts', '!../src/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// workerd ships a native Temporal, and prod runs the polyfill instead: without the swap the suite
// would pass against an implementation prod never executes.
it('swaps the runtime own Temporal for the polyfill', () => {
  expect(globalThis.Temporal).not.toBe(nativeTemporal);
});

// Nothing in the suite fails if the entry loses the import, since the setup file installs it too.
it('installs the swap in the entry, before anything else', () => {
  const firstStatement = entry
    .split('\n')
    .find(line => line.trim() !== '' && !line.trim().startsWith('//'));
  expect(firstStatement).toBe("import './temporal.ts';");
});

// The runtime's `Temporal.Now` reads the UNIX epoch inside a Durable Object; the clock is `Date.now()`.
it('never reads the clock through Temporal.Now', () => {
  const withoutComments = (source: string): string =>
    source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
  const offenders = Object.entries(sources)
    .filter(([, source]) => withoutComments(source).includes('Temporal.Now'))
    .map(([file]) => file);
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});
