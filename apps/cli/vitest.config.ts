import { defineConfig } from 'vitest/config';
import { iifePlugin } from './iife-plugin.ts';

export default defineConfig({
  plugins: [iifePlugin()],
});
