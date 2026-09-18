/** SQLSTATE raised when `lock_timeout` expires before a row lock is granted. */
const LOCK_NOT_AVAILABLE = '55P03';

const CODE_KEYS = ['code', 'originalCode'] as const;
const NESTED_KEYS = ['cause', 'meta', 'driverAdapterError'] as const;
const MAX_DEPTH = 6;

/**
 * Whether an error, however Prisma and the driver adapter have wrapped it, was Postgres
 * refusing to wait any longer for a lock.
 *
 * The SQLSTATE travels inside Prisma's error rather than on it. With Prisma 7.10 and
 * `@prisma/adapter-pg` it arrives as a `P2010` whose code sits at
 * `meta.driverAdapterError.cause.originalCode` — observed, not assumed, and pinned by
 * `postgres-errors.spec.ts`. The search walks the usual wrapping keys rather than hard-coding
 * that one path, so a minor re-nesting in a future release still matches; matching on the
 * code rather than message text keeps a reworded message from breaking it.
 */
export function isLockNotAvailable(error: unknown): boolean {
  return carriesCode(error, LOCK_NOT_AVAILABLE, new Set(), 0);
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
