import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { describeDatabase, testDatabaseUrl } from './database.js';

/**
 * Rebuilds the test database from the migrations before every run, so tests always exercise
 * exactly the schema — hand-written constraints and trigger included — that production gets.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const client = new pg.Client({ connectionString: url });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${describeDatabase(url)}. Is it running? Try \`npm run db:up\`.`,
      { cause: error },
    );
  }

  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  // The CLI's JavaScript entry point run with this Node, rather than the `.bin` shim: on
  // Windows that shim is a .cmd file, which Node refuses to spawn without a shell.
  execFileSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
    },
  );
}
