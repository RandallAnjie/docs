import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: true,
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((dep) => !dep.includes('database') && !dep.includes('katex')),
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/katex')) return 'katex';
          if (id.includes('DatabaseCanvas')) return 'database';
          if (
            id.includes('node_modules/yjs') ||
            id.includes('node_modules/y-websocket') ||
            id.includes('node_modules/y-indexeddb') ||
            id.includes('node_modules/y-protocols')
          ) {
            return 'collab';
          }
          if (id.includes('node_modules/@tiptap')) return 'editor';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/collab': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
});
