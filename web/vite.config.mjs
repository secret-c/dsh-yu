import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // Relative asset URLs keep the console working both at `/` and under the
  // harness origin at `/yu/`; the app uses hash routing so deep links never
  // change the document directory.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(here, '..', 'dist', 'web'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5199,
    proxy: { '/api': 'http://127.0.0.1:58800' },
  },
});
