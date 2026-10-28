import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { REMOTE_MANIFEST_FILE } from './src/shared/remote-console-config';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // The Remote Console (#254) serves ONLY the files in the manifest closure
    // of `remote/index.html` (main/remote-console/static-assets.ts), so the
    // build has to say what that closure is. Written as a plain file at the
    // outDir root rather than Vite's default `.vite/manifest.json`: a dot
    // directory is not guaranteed to survive electron-builder's `dist/**/*`
    // glob, and a manifest that silently went
    // missing from a release is a console that answers 503 `ui-not-built`.
    manifest: REMOTE_MANIFEST_FILE,
    // Vite 8 bundles with Rolldown; `rolldownOptions` is the current spelling
    // (`rollupOptions` is the deprecated alias). Two entries: the desktop
    // renderer, unchanged, and the phone console, which shares only what the
    // bundler decides is common (React) and nothing of the desktop's state.
    rolldownOptions: {
      input: {
        // `index`, not `main`: the key names the emitted chunk, and the release
        // steps (CLAUDE.md) grep assets/index-*.js for the desktop bundle.
        index: path.resolve(__dirname, 'src/renderer/index.html'),
        remote: path.resolve(__dirname, 'src/renderer/remote/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5199,
    strictPort: false,
    fs: {
      allow: [
        // Allow serving files from the entire project root (needed for src/shared/)
        path.resolve(__dirname),
      ],
    },
  },
});
