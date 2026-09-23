import { createPrismaClient, type PrismaClient } from '../../src/platform/prisma/prisma-client.js';

/** The test run's Postgres URL. Refuses anything not named like a test database: tests truncate. */
export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run these tests through `npm run test:int` or `npm run test:e2e`, which start their own containers.',
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

export function createTestPrisma(): PrismaClient {
  return createPrismaClient({ connectionString: testDatabaseUrl(), poolSize: 20 });
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  // TRUNCATE is not a row-level UPDATE or DELETE, so the ledger's append-only trigger does not
  // fire. That is fine for tests; in production the application role should not hold TRUNCATE.
  // Every table that references `programs` has to be named, or Postgres refuses the truncate.
  await prisma.$executeRawUnsafe(
    'TRUNCATE capacity_movements, treasury_events, outbox_events, reservations, programs',
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
