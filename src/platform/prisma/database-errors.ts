/*
 * Recognises "the database cannot be used right now", however Prisma and its pg adapter wrap
 * it, so callers can answer 503 and retry rather than treat an outage as a bug. The shapes are
 * the ones Prisma 7.10 with `@prisma/adapter-pg` produces (pinned by `database-errors.spec.ts`).
 */

/** Prisma error codes for an unreachable server, a timeout, or no free pooled connection. */
const PRISMA_CODES = new Set([
  'P1001', // can't reach database server
  'P1002', // server reached but timed out
  'P1008', // operations timed out
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API error: could not start in time, or timed out
]);

/** What `@prisma/adapter-pg` calls socket-level failures. */
const ADAPTER_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
]);

/** SQLSTATEs for a server that is shutting down, starting up, or full. */
const SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

/** pg-pool's own errors carry no code, only a message. */
const MESSAGES =
  /connection timeout|timeout exceeded when trying to connect|Connection terminated/i;

const NESTED_KEYS = ['cause', 'meta', 'driverAdapterError'] as const;
const MAX_DEPTH = 6;

export function isDatabaseUnavailable(error: unknown): boolean {
  return matches(error, new Set(), 0);
}

function matches(value: unknown, seen: Set<object>, depth: number): boolean {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const { code, kind, originalCode, message } = record;

  if (typeof code === 'string' && PRISMA_CODES.has(code)) return true;
  if (typeof kind === 'string' && ADAPTER_KINDS.has(kind)) return true;
  if (typeof originalCode === 'string' && isUnavailableSqlState(originalCode)) return true;
  if (typeof code === 'string' && isUnavailableSqlState(code)) return true;
  if (value instanceof Error && MESSAGES.test(String(message))) return true;

  return NESTED_KEYS.some((key) => matches(record[key], seen, depth + 1));
}

/** Class 08 is "connection exception". */
function isUnavailableSqlState(code: string): boolean {
  return SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code);
}
