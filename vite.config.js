import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lapisGeminiPlugin } from './server/vite-plugin.mjs';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), lapisGeminiPlugin()],
  base: '/personalizados/',
  resolve: {
    alias: [
      // Aba Ampliar: versão do ONNX Runtime que baixa o .wasm (21 MB) da internet, sem embutir no build.
      { find: /^onnxruntime-web\/webgpu$/, replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)) },
    ],
  },
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});
