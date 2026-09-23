import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export interface PrismaClientOptions {
  readonly connectionString: string;
  readonly poolSize?: number;
  readonly connectTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/** One per process: each client owns a connection pool. */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.poolSize,
    connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    query_timeout: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  });

  return new PrismaClient({ adapter });
}
