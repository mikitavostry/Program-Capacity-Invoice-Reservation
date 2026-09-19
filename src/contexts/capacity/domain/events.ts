import type { DomainEvent } from '../../../shared/domain/domain-event.js';
import type { Money } from '../../../shared/money/money.js';
import type { InvoiceId, ProgramId, RepaymentId, ReservationId } from './ids.js';

export class ProgramOpened implements DomainEvent {
  readonly eventName = 'ProgramOpened';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly creditLimit: Money;

  constructor(programId: ProgramId, creditLimit: Money, occurredAt: Date) {
    this.aggregateId = programId.value;
    this.creditLimit = creditLimit;
    this.occurredAt = new Date(occurredAt);
  }
}

export class CapacityReserved implements DomainEvent {
  readonly eventName = 'CapacityReserved';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly reservationId: ReservationId;
  readonly invoiceId: InvoiceId;
  readonly invoiceAmount: Money;
  readonly reservedAmount: Money;
  readonly availableAfter: Money;

  constructor(params: {
    programId: ProgramId;
    reservationId: ReservationId;
    invoiceId: InvoiceId;
    invoiceAmount: Money;
    reservedAmount: Money;
    availableAfter: Money;
    occurredAt: Date;
  }) {
    this.aggregateId = params.programId.value;
    this.reservationId = params.reservationId;
    this.invoiceId = params.invoiceId;
    this.invoiceAmount = params.invoiceAmount;
    this.reservedAmount = params.reservedAmount;
    this.availableAfter = params.availableAfter;
    this.occurredAt = new Date(params.occurredAt);
  }
}

/**
 * A repayment was applied to a reservation, freeing some or all of the capacity it held.
 *
 * `releasedAmount` can be zero: a small partial repayment against a converted invoice may be
 * worth less than one minor unit of the program's currency, and releases round down. The
 * repayment is still recorded, and the final repayment settles whatever remains.
 */
export class CapacityReleased implements DomainEvent {
  readonly eventName = 'CapacityReleased';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly reservationId: ReservationId;
  readonly invoiceId: InvoiceId;
  readonly repaymentId: RepaymentId;
  /** What was repaid, in the invoice's currency. */
  readonly repaidAmount: Money;
  /** The capacity this repayment freed, in the program's currency. */
  readonly releasedAmount: Money;
  readonly reservationFullyReleased: boolean;
  readonly availableAfter: Money;

  constructor(params: {
    programId: ProgramId;
    reservationId: ReservationId;
    invoiceId: InvoiceId;
    repaymentId: RepaymentId;
    repaidAmount: Money;
    releasedAmount: Money;
    reservationFullyReleased: boolean;
    availableAfter: Money;
    occurredAt: Date;
  }) {
    this.aggregateId = params.programId.value;
    this.reservationId = params.reservationId;
    this.invoiceId = params.invoiceId;
    this.repaymentId = params.repaymentId;
    this.repaidAmount = params.repaidAmount;
    this.releasedAmount = params.releasedAmount;
    this.reservationFullyReleased = params.reservationFullyReleased;
    this.availableAfter = params.availableAfter;
    this.occurredAt = new Date(params.occurredAt);
  }
}

/**
 * Treasury changed a program's credit limit.
 *
 * `overLimit` says the new limit is below what is already reserved: existing holds stand and
 * no new capacity can be taken until repayments bring the program back under (§4.5).
 */
export class CreditLimitChanged implements DomainEvent {
  readonly eventName = 'CreditLimitChanged';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly previousLimit: Money;
  readonly creditLimit: Money;
  readonly reservedAmount: Money;
  readonly overLimit: boolean;
  readonly treasurySequence: number;

  constructor(params: {
    programId: ProgramId;
    previousLimit: Money;
    creditLimit: Money;
    reservedAmount: Money;
    treasurySequence: number;
    occurredAt: Date;
  }) {
    this.aggregateId = params.programId.value;
    this.previousLimit = params.previousLimit;
    this.creditLimit = params.creditLimit;
    this.reservedAmount = params.reservedAmount;
    this.overLimit = params.reservedAmount.isGreaterThan(params.creditLimit);
    this.treasurySequence = params.treasurySequence;
    this.occurredAt = new Date(params.occurredAt);
  }
}

/**
 * Treasury's view of how much a program has reserved does not match ours.
 *
 * Raised, not repaired. Our figure is backed by per-invoice reservations and an immutable
 * ledger; overwriting it with a number we cannot explain would destroy that chain and the
 * drift detector with it. The discrepancy is surfaced for someone to investigate.
 */
export class CapacityDiscrepancyDetected implements DomainEvent {
  readonly eventName = 'CapacityDiscrepancyDetected';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  /** What treasury believes is reserved. */
  readonly reportedAmount: Money;
  /** What this service holds, and continues to hold. */
  readonly reservedAmount: Money;
  /** Reported minus ours: positive when treasury thinks more is held than we do. */
  readonly difference: Money;
  readonly treasurySequence: number;

  constructor(params: {
    programId: ProgramId;
    reportedAmount: Money;
    reservedAmount: Money;
    treasurySequence: number;
    occurredAt: Date;
  }) {
    this.aggregateId = params.programId.value;
    this.reportedAmount = params.reportedAmount;
    this.reservedAmount = params.reservedAmount;
    this.difference = params.reportedAmount.minus(params.reservedAmount);
    this.treasurySequence = params.treasurySequence;
    this.occurredAt = new Date(params.occurredAt);
  }
}
