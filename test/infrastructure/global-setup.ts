import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedpandaContainer } from '@testcontainers/redpanda';
import type { TestProject } from 'vitest/node';

/*
 * Starts Postgres and Redpanda containers on random ports for this test run, separate from the
 * `docker compose` stack. The images match docker-compose.yml.
 */

const POSTGRES_IMAGE = 'postgres:17-alpine';
const REDPANDA_IMAGE = 'redpandadata/redpanda:v25.2.5';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of this run's Postgres container. */
    testDatabaseUrl: string;
    /** Bootstrap servers of this run's Kafka container. */
    kafkaBrokers: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, redpanda] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('capacity_test')
      .withUsername('capacity')
      .withPassword('capacity')
      .start(),
    new RedpandaContainer(REDPANDA_IMAGE).start(),
  ]).catch((error: unknown) => {
    throw new Error(
      'Could not start the test containers (Postgres and Redpanda). Is Docker running?',
      { cause: error },
    );
  });

  const databaseUrl = postgres.getConnectionUri();
  migrate(databaseUrl);

  project.provide('testDatabaseUrl', databaseUrl);
  project.provide('kafkaBrokers', redpanda.getBootstrapServers());

  return async () => {
    await Promise.all([postgres.stop(), redpanda.stop()]);
  };
}

/** From the migrations, so tests get production's hand-written constraints and triggers. */
function migrate(databaseUrl: string): void {
  // Not the `.bin` shim: on Windows it is a .cmd file, which Node will not spawn without a shell.
  execFileSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );
}
