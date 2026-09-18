import { defineConfig } from 'vitest/config';

// End-to-end tests boot the real application — every module, guard, pipe and filter — against
// the same disposable Postgres database as the integration suite (`npm run db:up`).
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
