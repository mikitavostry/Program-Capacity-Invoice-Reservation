import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import type { Money } from '../../../../shared/money/money.js';
import type { ProgramId, RepaymentId, ReservationId } from '../ids.js';

/** A repayment the ledger has already applied — what a replay of it must return. */
export interface RecordedRepayment {
  readonly reservationId: ReservationId;
  /** In the invoice's currency. */
  readonly repaidAmount: Money;
  /** In the program's currency; may be zero. */
  readonly releasedAmount: Money;
  readonly occurredAt: Date;
}

/**
 * The append-only record of every change to a program's reserved capacity.
 *
 * It is an audit log beside the program's counter, not the system of record: the counter
 * remains what the capacity check reads. See docs/architecture.md §8.
 */
export interface CapacityLedger {
  /**
   * Writes one movement for each event that changed capacity. Must be called in the same
   * transaction as the change itself, so the ledger and the counter cannot disagree.
   */
  record(events: readonly DomainEvent[]): Promise<void>;

  findRepayment(programId: ProgramId, repaymentId: RepaymentId): Promise<RecordedRepayment | null>;
}
