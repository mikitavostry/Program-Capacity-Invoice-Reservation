import { existsSync } from 'node:fs';
import { createPrismaClient, type PrismaClient } from '../../src/platform/prisma/prisma-client.js';

/**
 * The integration database's URL, refusing anything that does not look like a test database.
 * These tests drop the schema and truncate tables; pointing them at real data by mistake
 * should be impossible, not merely unlikely.
 */
export function testDatabaseUrl(): string {
  if (process.env['TEST_DATABASE_URL'] === undefined && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env to use the local one.',
    );
  }

  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": they wipe it, so its name must contain "test".`,
    );
  }

  return url;
}

/** Credentials stripped, for error messages. */
export function describeDatabase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

export function createTestPrisma(): PrismaClient {
  return createPrismaClient({ connectionString: testDatabaseUrl(), poolSize: 20 });
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  // TRUNCATE is not a row-level UPDATE or DELETE, so the ledger's append-only trigger does not
  // fire. That is fine for tests; in production the application role should not hold TRUNCATE.
  // Every table that references `programs` has to be named, or Postgres refuses the truncate.
  await prisma.$executeRawUnsafe(
    'TRUNCATE capacity_movements, treasury_events, reservations, programs',
  );
}

export interface CapacityTotals {
  /** `programs.reserved_minor` — what the capacity check reads. */
  readonly counter: bigint;
  /** What the active reservations are still holding. */
  readonly held: bigint;
  /** Reserves minus releases in the ledger. */
  readonly ledger: bigint;
}

/** The counter and the two independent ways of recomputing it. All three must always agree. */
export async function capacityTotals(
  prisma: PrismaClient,
  programId: string,
): Promise<CapacityTotals> {
  const [row] = await prisma.$queryRaw<CapacityTotals[]>`
    SELECT p.reserved_minor AS counter,
           (SELECT COALESCE(SUM(r.reserved_minor - r.released_minor), 0)::bigint
              FROM reservations r
             WHERE r.program_id = p.id AND r.status = 'ACTIVE') AS held,
           (SELECT COALESCE(SUM(CASE m.type WHEN 'RESERVE' THEN m.amount_minor
                                             ELSE -m.amount_minor END), 0)::bigint
              FROM capacity_movements m
             WHERE m.program_id = p.id) AS ledger
      FROM programs p
     WHERE p.id = ${programId}`;

  if (row === undefined) throw new Error(`No program ${programId}.`);

  return row;
}
