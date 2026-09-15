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
    // The app calls /app/api/... in both dev and production, so the dev proxy
    // strips the /app prefix the backend does not know about. Keeping the two
    // environments on one path is what stops a 404 that only appears once it
    // is behind nginx.
    proxy: {
      '/app/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/app/, ''),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
