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
