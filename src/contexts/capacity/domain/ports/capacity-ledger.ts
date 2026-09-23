import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import type { Money } from '../../../../shared/money/money.js';
import type { ProgramId, RepaymentId, ReservationId } from '../ids.js';

export interface RecordedRepayment {
  readonly reservationId: ReservationId;
  /** In the invoice's currency. */
  readonly repaidAmount: Money;
  /** In the program's currency; may be zero. */
  readonly releasedAmount: Money;
  readonly occurredAt: Date;
}

/** Append-only audit of every movement of a program's reserved amount. */
export interface CapacityLedger {
  /** One movement per event that moved capacity, in the same transaction as the change. */
  record(events: readonly DomainEvent[]): Promise<void>;

  findRepayment(programId: ProgramId, repaymentId: RepaymentId): Promise<RecordedRepayment | null>;
}
