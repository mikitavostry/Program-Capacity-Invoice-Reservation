import { DomainError } from '../../../shared/domain/domain-error.js';
import type { Currency } from '../../../shared/money/currency.js';
import type { ExchangeRate } from '../../../shared/money/exchange-rate.js';
import type { Money } from '../../../shared/money/money.js';
import type { InvoiceId, ProgramId, ReservationId } from './ids.js';

export class InsufficientCapacityError extends DomainError {
  readonly code = 'INSUFFICIENT_CAPACITY';
  readonly programId: ProgramId;
  readonly requested: Money;
  readonly available: Money;

  constructor(programId: ProgramId, requested: Money, available: Money) {
    super(
      `Program ${programId.value} cannot reserve ${requested}: only ${available} is available.`,
    );
    this.programId = programId;
    this.requested = requested;
    this.available = available;
  }
}

export class ProgramNotActiveError extends DomainError {
  readonly code = 'PROGRAM_NOT_ACTIVE';

  constructor(programId: ProgramId, status: string) {
    super(`Program ${programId.value} is ${status} and cannot accept new reservations.`);
  }
}

export class ReservationAlreadyReleasedError extends DomainError {
  readonly code = 'RESERVATION_ALREADY_RELEASED';

  constructor(reservationId: ReservationId) {
    super(`Reservation ${reservationId.value} has already been released.`);
  }
}

export class RepaymentExceedsOutstandingError extends DomainError {
  readonly code = 'REPAYMENT_EXCEEDS_OUTSTANDING';
  readonly invoiceId: InvoiceId;
  readonly repayment: Money;
  readonly outstanding: Money;

  constructor(invoiceId: InvoiceId, repayment: Money, outstanding: Money) {
    super(
      `Invoice ${invoiceId.value} has ${outstanding} outstanding; a repayment of ${repayment} would overpay it.`,
    );
    this.invoiceId = invoiceId;
    this.repayment = repayment;
    this.outstanding = outstanding;
  }
}

export class RepaymentCurrencyMismatchError extends DomainError {
  readonly code = 'REPAYMENT_CURRENCY_MISMATCH';

  constructor(invoiceId: InvoiceId, invoiceCurrency: Currency, repaymentCurrency: Currency) {
    super(
      `Invoice ${invoiceId.value} is in ${invoiceCurrency.code}; a repayment in ${repaymentCurrency.code} cannot be applied to it.`,
    );
  }
}

export class ReservationProgramMismatchError extends DomainError {
  readonly code = 'RESERVATION_PROGRAM_MISMATCH';

  constructor(reservationId: ReservationId, expected: ProgramId, actual: ProgramId) {
    super(
      `Reservation ${reservationId.value} belongs to program ${actual.value}, not ${expected.value}.`,
    );
  }
}

/** An invoice amount could not be brought into the program's currency with what was supplied. */
export class ExchangeRateUnusableError extends DomainError {
  readonly code = 'CURRENCY_NOT_CONVERTIBLE';

  private constructor(message: string) {
    super(message);
  }

  static missing(from: Currency, to: Currency): ExchangeRateUnusableError {
    return new ExchangeRateUnusableError(
      `An amount in ${from.code} needs a ${from.code}/${to.code} rate to be reserved against a ${to.code} program.`,
    );
  }

  static wrongTarget(rate: ExchangeRate, programCurrency: Currency): ExchangeRateUnusableError {
    return new ExchangeRateUnusableError(
      `A ${rate.from.code}/${rate.to.code} rate cannot be used against a ${programCurrency.code} program.`,
    );
  }
}
