import { defineConfig } from 'vitest/config';

// Integration tests run against real Postgres and Kafka, in containers the global setup starts
// for the run and removes afterwards (Docker must be running). They are kept out of the
// default `npm test` run so the unit suite stays fast and needs no infrastructure.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    globalSetup: ['./test/infrastructure/global-setup.ts'],
    setupFiles: ['./test/infrastructure/container-env.ts'],
    // One shared database: files running at once would truncate each other's data.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
