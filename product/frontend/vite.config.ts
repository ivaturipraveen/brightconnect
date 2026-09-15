import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Served under /app/ behind nginx, so assets must be referenced from there.
  // Without this the page asks for /assets/index.js, which falls through to the
  // dashboard's SPA handler and comes back as HTML - the browser then refuses
  // it for the wrong MIME type and the app never starts.
  base: '/app/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // Talk to the chat API without CORS or a hardcoded host.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
