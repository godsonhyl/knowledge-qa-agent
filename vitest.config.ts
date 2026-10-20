import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@server': new URL('./src/server', import.meta.url).pathname,
      '@web': new URL('./src/web', import.meta.url).pathname,
    },
  },
});
