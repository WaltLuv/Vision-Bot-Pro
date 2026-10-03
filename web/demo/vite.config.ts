import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Builds the real application with a stand-in gateway, as one self-contained
// file that can be inlined into a published page.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset paths, so the same build also works served at the gateway's /preview/.
  base: './',
  resolve: {alias: {'livekit-client': fileURLToPath(new URL('./livekit-stub.ts', import.meta.url))}},
  build: {
    outDir: fileURLToPath(new URL('../demo-dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: {polyfill: false},
    rollupOptions: {output: {inlineDynamicImports: true, entryFileNames: 'demo.js', assetFileNames: 'demo.[ext]'}},
  },
});
