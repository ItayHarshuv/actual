import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const packageDirectory = fileURLToPath(new URL('.', import.meta.url));
const apiDistDirectory = path.resolve(packageDirectory, '../api/dist');
const importerDistDirectory = path.resolve(packageDirectory, 'dist');

function copyActualApiRuntimeAssets() {
  return {
    name: 'copy-actual-api-runtime-assets',
    closeBundle() {
      const migrationsSource = path.join(apiDistDirectory, 'migrations');
      const defaultDatabaseSource = path.join(
        apiDistDirectory,
        'default-db.sqlite',
      );
      if (
        !fs.existsSync(migrationsSource) ||
        !fs.existsSync(defaultDatabaseSource)
      ) {
        throw new Error(
          'Actual API runtime assets are missing; build @actual-app/api first',
        );
      }

      fs.cpSync(
        migrationsSource,
        path.join(importerDistDirectory, 'migrations'),
        { recursive: true },
      );
      fs.copyFileSync(
        defaultDatabaseSource,
        path.join(importerDistDirectory, 'default-db.sqlite'),
      );
    },
  };
}

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
  plugins: [copyActualApiRuntimeAssets()],
});
