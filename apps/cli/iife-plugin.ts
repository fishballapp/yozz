import { type Plugin, rolldown } from 'rolldown';

const SUFFIX = '?iife';
const VIRTUAL = '\0iife:';

/**
 * `import script from 'module?iife'` is that module bundled for a browser, as a string. tsdown and
 * Vitest both run it, so a test and `dist/bin.js` hold the same script, built from the same
 * sources, with nothing generated to remember.
 */
export const iifePlugin = () =>
  ({
    name: 'yozz:iife',
    enforce: 'pre',
    resolveId: {
      filter: { id: /\?iife$/ },
      async handler(source, importer) {
        const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer);
        return resolved === null ? null : `${VIRTUAL}${resolved.id}`;
      },
    },
    load: {
      filter: { id: /^\0iife:/ },
      async handler(id) {
        const bundle = await rolldown({
          input: id.slice(VIRTUAL.length),
          platform: 'browser',
          logLevel: 'warn',
        });
        const { output } = await bundle.generate({ format: 'iife', minify: true });
        await bundle.close();
        const [{ code, moduleIds }] = output;
        for (const file of moduleIds) this.addWatchFile(file);
        // Inlined in a <script>, whose text ends at `</script`, and past `<!--` then `<script` does
        // not end there. The bundle holds these only in strings, where `\x3c` means the same.
        const inlinable = code.replace(/<(?=!--|script)/gi, '\\x3c');
        if (/<\/script/i.test(inlinable)) {
          throw new Error(`${id.slice(VIRTUAL.length)} can't be inlined in a <script>`);
        }
        return { code: `export default ${JSON.stringify(inlinable)};`, moduleType: 'js' };
      },
    },
  }) satisfies Plugin & { readonly enforce: 'pre' };
