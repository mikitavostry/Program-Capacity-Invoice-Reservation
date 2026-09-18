import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { CapacityLedger } from './capacity-ledger.js';
import type { ProgramRepository } from './program-repository.js';
import type { ReservationRepository } from './reservation-repository.js';

/** Repositories bound to one transaction: everything written through them commits together. */
export interface CapacityUnitOfWork {
  readonly programs: ProgramRepository;
  readonly reservations: ReservationRepository;
  readonly ledger: CapacityLedger;
}

export interface CapacityTransactionRunner {
  /**
   * Runs `work` in one transaction, committing if it resolves and rolling back if it throws.
   *
   * Nothing slow belongs inside `work` — no network calls, no rate lookups. Program rows are
   * locked for its whole duration, so anything slow in here stalls every other writer on the
   * same program. Fetch what you need first, then open the transaction.
   *
   * Rejects with `CapacityBusyError` when a program lock could not be acquired in time.
   */
  run<T>(work: (unitOfWork: CapacityUnitOfWork) => Promise<T>): Promise<T>;
}

export const CAPACITY_TRANSACTION_RUNNER = Symbol('CapacityTransactionRunner');

/**
 * A program was too contended to lock within the configured wait.
 *
 * Not a business rule — nothing was wrong with the request, and nothing was written. It is
 * part of the transaction runner's contract so callers can report it as retryable instead
 * of letting waiters queue on the database until the connection pool runs dry.
 */
export class CapacityBusyError extends DomainError {
  readonly code = 'CAPACITY_BUSY';

  constructor() {
    super('The program is busy with other changes; retry shortly.');
  }
}
