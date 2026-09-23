import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '../prisma-client.js';
import { isDatabaseUnavailable } from '../database-errors.js';

/** Errors as Prisma 7.10 with `@prisma/adapter-pg` really throws them, trimmed to what matters. */
function prismaError(code: string, kind?: string): Error {
  return Object.assign(new Error(`Prisma error ${code}`), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta:
      kind === undefined
        ? undefined
        : { driverAdapterError: { name: 'DriverAdapterError', cause: { kind } } },
  });
}

describe('isDatabaseUnavailable', () => {
  it.each([
    ['a refused connection, from a query', prismaError('P2010', 'DatabaseNotReachable')],
    ['a refused connection, from a transaction', prismaError('P1001', 'DatabaseNotReachable')],
    ['no transaction could start in time', prismaError('P2028')],
    ['no pooled connection in time', prismaError('P2024')],
    ['a connection that closed', prismaError('P2010', 'ConnectionClosed')],
    ['a socket timeout', prismaError('P2010', 'SocketTimeout')],
    ['too many connections', prismaError('P2010', 'TooManyConnections')],
    [
      'the connect timeout, which pg-pool raises without a code',
      Object.assign(new Error('Connection terminated due to connection timeout'), {
        cause: new Error('Connection terminated unexpectedly'),
      }),
    ],
    [
      'a server shutting down',
      Object.assign(prismaError('P2010'), {
        meta: { driverAdapterError: { cause: { originalCode: '57P01' } } },
      }),
    ],
    [
      'a connection exception (SQLSTATE class 08)',
      Object.assign(prismaError('P2010'), {
        meta: { driverAdapterError: { cause: { originalCode: '08006' } } },
      }),
    ],
  ])('recognises %s', (_, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ['a unique violation', prismaError('P2002', 'UniqueConstraintViolation')],
    ['a check violation', prismaError('P2010', 'postgres')],
    ['an ordinary bug', new TypeError('cannot read properties of undefined')],
    ['a non-error', 'connection timeout'],
    ['nothing', undefined],
  ])('does not mistake %s for an outage', (_, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });

  it('recognises what a real client throws when nothing listens on the port', async () => {
    const prisma = createPrismaClient({
      connectionString: 'postgresql://capacity:capacity@127.0.0.1:1/capacity',
      connectTimeoutMs: 1_000,
    });

    try {
      const query = await prisma.$queryRaw`SELECT 1`.catch((error: unknown) => error);
      const transaction = await prisma
        .$transaction(async (tx) => tx.$queryRaw`SELECT 1`)
        .catch((error: unknown) => error);

      expect(isDatabaseUnavailable(query)).toBe(true);
      expect(isDatabaseUnavailable(transaction)).toBe(true);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  });
});
