import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export interface PrismaClientOptions {
  readonly connectionString: string;
  /** Upper bound on pooled connections. Every waiter on a locked program holds one. */
  readonly poolSize?: number;
}

/**
 * Builds the one Prisma client a process should hold. Each client owns a connection pool,
 * so creating one per request would exhaust the database long before it ran out of work.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolSize,
  });

  return new PrismaClient({ adapter });
}
