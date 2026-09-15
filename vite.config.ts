import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // The console lives in web/; everything else in the repo is the server.
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Talk to the API in dev without CORS or a hardcoded host.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
