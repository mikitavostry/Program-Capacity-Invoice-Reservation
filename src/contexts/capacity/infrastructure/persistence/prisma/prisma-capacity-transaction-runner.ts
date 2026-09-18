import { Prisma, type PrismaClient } from '../../../../../generated/prisma/client.js';
import {
  CapacityBusyError,
  type CapacityTransactionRunner,
  type CapacityUnitOfWork,
} from '../../../domain/ports/capacity-transaction-runner.js';
import { isLockNotAvailable } from './postgres-errors.js';
import { PrismaCapacityLedger } from './prisma-capacity-ledger.js';
import { PrismaProgramRepository } from './prisma-program-repository.js';
import { PrismaReservationRepository } from './prisma-reservation-repository.js';

export interface TransactionSettings {
  /** How long to wait for a program's row lock before giving up with `CapacityBusyError`. */
  readonly lockTimeoutMs: number;
  /** Ceiling on any single statement. */
  readonly statementTimeoutMs: number;
  /** Ceiling on the whole transaction, enforced by Prisma on the application side. */
  readonly transactionTimeoutMs: number;
  /** How long to wait for a pooled connection to start the transaction on. */
  readonly maxWaitMs: number;
}

/**
 * The lock wait is deliberately the shortest of these. A waiter that cannot get the lock
 * should give up and report a retryable error well before it could exhaust the connection
 * pool or run into the transaction ceiling. See docs/architecture.md §6.
 */
export const DEFAULT_TRANSACTION_SETTINGS: TransactionSettings = {
  lockTimeoutMs: 3_000,
  statementTimeoutMs: 5_000,
  transactionTimeoutMs: 10_000,
  maxWaitMs: 5_000,
};

export class PrismaCapacityTransactionRunner implements CapacityTransactionRunner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: TransactionSettings = DEFAULT_TRANSACTION_SETTINGS,
  ) {}

  async run<T>(work: (unitOfWork: CapacityUnitOfWork) => Promise<T>): Promise<T> {
    const { lockTimeoutMs, statementTimeoutMs, transactionTimeoutMs, maxWaitMs } = this.settings;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Scoped to this transaction only (the `true`), so a pooled connection never carries
          // one caller's limits into another's. The idle timeout frees a lock if this process
          // stalls mid-transaction while its connection stays open.
          await tx.$queryRaw`
            SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                   set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true),
                   set_config('idle_in_transaction_session_timeout', ${`${transactionTimeoutMs}ms`}, true)`;

          return work({
            programs: new PrismaProgramRepository(tx),
            reservations: new PrismaReservationRepository(tx),
            ledger: new PrismaCapacityLedger(tx),
          });
        },
        {
          // Postgres's default, stated so nobody has to wonder. The row lock, not the isolation
          // level, is what serialises writers to a program.
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: maxWaitMs,
          timeout: transactionTimeoutMs,
        },
      );
    } catch (error) {
      if (isLockNotAvailable(error)) throw new CapacityBusyError();
      throw error;
    }
  }
}
