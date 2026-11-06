import { defineConfig } from 'tsup';

// BUNDLE_ALL=1 (used by the Docker image) inlines every dependency into dist/index.js so the
// runtime image needs no node_modules. Otherwise only the workspace package is inlined.
const bundleAll = process.env.BUNDLE_ALL === '1';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: bundleAll ? [/.*/] : ['@myciti/shared'],
  banner: bundleAll
    ? { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
    : undefined,
});
