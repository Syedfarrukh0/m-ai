import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  external: ['zod', '@m-ai/action-contract'],
});
