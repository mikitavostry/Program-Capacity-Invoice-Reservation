import { Prisma, type PrismaClient } from '../../../../../generated/prisma/client.js';
import {
  CapacityBusyError,
  type CapacityTransactionRunner,
  type CapacityUnitOfWork,
} from '../../../domain/ports/capacity-transaction-runner.js';
import { isLockNotAvailable } from './postgres-errors.js';
import { PrismaCapacityLedger } from './prisma-capacity-ledger.js';
import { PrismaEventOutbox } from './prisma-event-outbox.js';
import { PrismaProgramRepository } from './prisma-program-repository.js';
import { PrismaReservationRepository } from './prisma-reservation-repository.js';
import { PrismaTreasuryEventLog } from './prisma-treasury-event-log.js';

export interface TransactionSettings {
  /** How long to wait for a program's row lock before giving up with `CapacityBusyError`. */
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly transactionTimeoutMs: number;
  readonly maxWaitMs: number;
}

/** The lock wait is the shortest, so a waiter gives up (retryably) before anything else does. */
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
          // `true` scopes these to this transaction, not the pooled connection. The idle timeout
          // releases the locks if this process stalls mid-transaction.
          await tx.$queryRaw`
            SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
                   set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true),
                   set_config('idle_in_transaction_session_timeout', ${`${transactionTimeoutMs}ms`}, true)`;

          return work({
            programs: new PrismaProgramRepository(tx),
            reservations: new PrismaReservationRepository(tx),
            ledger: new PrismaCapacityLedger(tx),
            treasuryEvents: new PrismaTreasuryEventLog(tx),
            outbox: new PrismaEventOutbox(tx),
          });
        },
        {
          // The row lock, not the isolation level, serialises writers to a program.
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
