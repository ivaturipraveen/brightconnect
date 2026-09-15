import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // Talk to the chat API without CORS or a hardcoded host.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
