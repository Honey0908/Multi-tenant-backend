import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
    // Without this, a local `npm run build` leaves compiled *.test.js files
    // under dist/, and vitest's default include pattern picks those up too
    // — silently doubling every test run.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
