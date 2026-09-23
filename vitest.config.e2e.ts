import { defineConfig } from 'vitest/config';

// End-to-end tests boot the real application — every module, guard, pipe and filter — against
// Postgres and Kafka containers started for the run, the same way as the integration suite.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/infrastructure/global-setup.ts'],
    setupFiles: ['./test/infrastructure/container-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
