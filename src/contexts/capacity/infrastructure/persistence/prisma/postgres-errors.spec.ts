import { describe, expect, it } from 'vitest';
import { isLockNotAvailable, isUniqueViolation } from './postgres-errors.js';

/**
 * The error Prisma 7.10 with `@prisma/adapter-pg` actually raises when `lock_timeout` expires,
 * captured from a real Postgres and trimmed to the fields that matter. If an upgrade moves the
 * code somewhere this no longer finds, lock timeouts would surface as 500s instead of a
 * retryable 503 — this test is here to make that loud.
 */
const observedLockTimeout = {
  name: 'PrismaClientKnownRequestError',
  code: 'P2010',
  message: 'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      message: 'canceling statement due to lock timeout',
      cause: {
        kind: 'postgres',
        code: '55P03',
        originalCode: '55P03',
        originalMessage: 'canceling statement due to lock timeout',
      },
    },
  },
};

describe('isLockNotAvailable', () => {
  it('recognises a lock timeout as Prisma and the pg adapter really report it', () => {
    expect(isLockNotAvailable(observedLockTimeout)).toBe(true);
  });

  it('recognises the code carried directly or through a cause chain', () => {
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
    expect(isLockNotAvailable(new Error('wrapped', { cause: { code: '55P03' } }))).toBe(true);
  });

  it('ignores other database errors, including other raw-query failures', () => {
    const uniqueViolation = {
      ...observedLockTimeout,
      meta: { driverAdapterError: { cause: { code: '23505', originalCode: '23505' } } },
    };

    expect(isLockNotAvailable(uniqueViolation)).toBe(false);
  });

  it('does not match on message text alone', () => {
    expect(isLockNotAvailable(new Error('canceling statement due to lock timeout'))).toBe(false);
  });

  it.each([null, undefined, '55P03', 42])('treats %s as not a lock timeout', (value) => {
    expect(isLockNotAvailable(value)).toBe(false);
  });

  it('survives an error that refers back to itself', () => {
    const circular: Record<string, unknown> = { code: 'P2010' };
    circular['cause'] = circular;

    expect(isLockNotAvailable(circular)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('recognises Prisma’s own code for a duplicate key', () => {
    expect(isUniqueViolation({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBe(true);
  });

  it('recognises the Postgres SQLSTATE carried inside a driver adapter error', () => {
    expect(
      isUniqueViolation({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
      }),
    ).toBe(true);
  });

  it('does not mistake a lock timeout for a duplicate', () => {
    expect(isUniqueViolation(observedLockTimeout)).toBe(false);
  });
});
