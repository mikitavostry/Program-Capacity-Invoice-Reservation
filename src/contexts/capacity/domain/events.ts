import type { DomainEvent } from '../../../shared/domain/domain-event.js';
import type { Money } from '../../../shared/money/money.js';
import type { InvoiceId, ProgramId, RepaymentId, ReservationId } from './ids.js';
import type { ProgramStatus } from './program.js';

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

/** A repayment freed some or all of a reservation's hold. `releasedAmount` may be zero. */
export class CapacityReleased implements DomainEvent {
  readonly eventName = 'CapacityReleased';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly reservationId: ReservationId;
  readonly invoiceId: InvoiceId;
  readonly repaymentId: RepaymentId;
  /** In the invoice's currency. */
  readonly repaidAmount: Money;
  /** In the program's currency. */
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

export class ProgramStatusChanged implements DomainEvent {
  readonly eventName = 'ProgramStatusChanged';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly previousStatus: ProgramStatus;
  readonly status: ProgramStatus;
  readonly treasurySequence: number;

  constructor(params: {
    programId: ProgramId;
    previousStatus: ProgramStatus;
    status: ProgramStatus;
    treasurySequence: number;
    occurredAt: Date;
  }) {
    this.aggregateId = params.programId.value;
    this.previousStatus = params.previousStatus;
    this.status = params.status;
    this.treasurySequence = params.treasurySequence;
    this.occurredAt = new Date(params.occurredAt);
  }
}
