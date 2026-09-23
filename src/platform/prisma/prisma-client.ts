import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export { Prisma, PrismaClient } from '../../generated/prisma/client.js';

export interface PrismaClientOptions {
  readonly connectionString: string;
  /** Upper bound on pooled connections. Every waiter on a locked program holds one. */
  readonly poolSize?: number;
  /**
   * How long to wait for a new connection. Without it, an unreachable database leaves every
   * request waiting on the operating system's TCP timeout, which can be minutes.
   */
  readonly connectTimeoutMs?: number;
  /**
   * Client-side cap on any single query, so one sent to a database that stopped answering
   * mid-connection fails instead of hanging. Longer than the server's statement timeout.
   */
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
