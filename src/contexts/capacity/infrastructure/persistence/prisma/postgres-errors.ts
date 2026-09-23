/** SQLSTATE raised when `lock_timeout` expires before a row lock is granted. */
const LOCK_NOT_AVAILABLE = '55P03';
/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';
/** Prisma's own code for a unique constraint violation raised through its query API. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

const CODE_KEYS = ['code', 'originalCode'] as const;
const NESTED_KEYS = ['cause', 'meta', 'driverAdapterError'] as const;
const MAX_DEPTH = 6;

/**
 * Whether Postgres gave up waiting for a lock, however Prisma wrapped the error. With Prisma
 * 7.10 and `@prisma/adapter-pg` the SQLSTATE sits at `meta.driverAdapterError.cause.originalCode`
 * (pinned by `postgres-errors.spec.ts`); walking the wrapping keys survives a re-nesting.
 */
export function isLockNotAvailable(error: unknown): boolean {
  return carriesCode(error, LOCK_NOT_AVAILABLE, new Set(), 0);
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    carriesCode(error, PRISMA_UNIQUE_VIOLATION, new Set(), 0) ||
    carriesCode(error, UNIQUE_VIOLATION, new Set(), 0)
  );
}

function carriesCode(value: unknown, code: string, seen: Set<object>, depth: number): boolean {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;

  if (CODE_KEYS.some((key) => record[key] === code)) return true;

  return NESTED_KEYS.some((key) => carriesCode(record[key], code, seen, depth + 1));
}
