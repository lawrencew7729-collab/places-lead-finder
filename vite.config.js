import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2020',
  },
  server: {
    port: 5174,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js', 'src/**/*.test.js'],
    exclude: ['node_modules/**', 'control-dashboard/**', 'dist/**', '_guide_build/**', '_hma_build/**'],
  },
});
