import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    target: 'chrome148',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('../../../src/hosts/overlay/index.ts', import.meta.url)),
      name: 'LilotabScaleOverlay',
      formats: ['iife'],
      fileName: () => 'overlay.js',
    },
  },
});
