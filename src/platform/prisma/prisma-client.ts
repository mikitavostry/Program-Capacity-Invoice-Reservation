import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export interface PrismaClientOptions {
  readonly connectionString: string;
  /** Upper bound on pooled connections. Every waiter on a locked program holds one. */
  readonly poolSize?: number;
}

/** One per process: each client owns a connection pool. */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolSize,
  });

  return new PrismaClient({ adapter });
}
