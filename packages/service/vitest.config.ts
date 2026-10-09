import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The same as tsconfig's paths: tests run against the packages' source.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@m-ai\/assistant-core\/testing$/, replacement: src('../assistant-core/src/testing/index.ts') },
      { find: /^@m-ai\/assistant-core$/, replacement: src('../assistant-core/src/index.ts') },
      { find: /^@m-ai\/action-contract\/testing$/, replacement: src('../action-contract/src/testing/index.ts') },
      { find: /^@m-ai\/action-contract$/, replacement: src('../action-contract/src/index.ts') },
    ],
  },
});
