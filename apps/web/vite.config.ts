import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Talk to the API in dev without CORS or hardcoded hosts.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true, ws: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
