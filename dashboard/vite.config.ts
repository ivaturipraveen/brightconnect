import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Resolved from this file, not the working directory - the config is invoked
  // as `vite --config dashboard/vite.config.ts` from the repository root.
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Talk to the API in dev without CORS or a hardcoded host.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
