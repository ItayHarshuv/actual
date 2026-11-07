import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@actual-app/api': fileURLToPath(
        new URL('../api/dist/index.js', import.meta.url),
      ),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    ssr: 'src/index.ts',
    target: 'node22',
    rollupOptions: {
      output: {
        entryFileNames: 'index.cjs',
        format: 'cjs',
      },
    },
  },
  ssr: {
    noExternal: ['@actual-app/api'],
  },
});
