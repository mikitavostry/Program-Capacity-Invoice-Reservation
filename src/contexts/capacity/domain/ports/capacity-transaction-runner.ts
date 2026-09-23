import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { CapacityLedger } from './capacity-ledger.js';
import type { EventOutbox } from './event-outbox.js';
import type { ProgramRepository } from './program-repository.js';
import type { ReservationRepository } from './reservation-repository.js';
import type { TreasuryEventLog } from './treasury-event-log.js';

export interface CapacityUnitOfWork {
  readonly programs: ProgramRepository;
  readonly reservations: ReservationRepository;
  readonly ledger: CapacityLedger;
  readonly treasuryEvents: TreasuryEventLog;
  readonly outbox: EventOutbox;
}

export interface CapacityTransactionRunner {
  /**
   * Runs `work` in one transaction. Keep it fast: program rows stay locked until it ends, so
   * fetch anything slow (such as exchange rates) first. Rejects with `CapacityBusyError` when
   * a program lock is not granted in time.
   */
  run<T>(work: (unitOfWork: CapacityUnitOfWork) => Promise<T>): Promise<T>;
}

export const CAPACITY_TRANSACTION_RUNNER = Symbol('CapacityTransactionRunner');

/** A program lock was not granted in time. Nothing was written; the request can be retried. */
export class CapacityBusyError extends DomainError {
  readonly code = 'CAPACITY_BUSY';

  constructor() {
    super('The program is busy with other changes; retry shortly.');
  }
}
