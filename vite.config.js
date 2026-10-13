import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lapisGeminiPlugin } from './server/vite-plugin.mjs';

export default defineConfig({
  plugins: [react(), lapisGeminiPlugin()],
  base: '/personalizados/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});
