import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Prebundle the same CommonJS module consumed by the Node email generator.
  optimizeDeps: { include: ['@monday-ops/reporting-core'] },
  build: {
    commonjsOptions: { include: [/node_modules/, /movement-daily-core\.cjs$/] },
    outDir: 'dist',
    emptyOutDir: true
  }
});
