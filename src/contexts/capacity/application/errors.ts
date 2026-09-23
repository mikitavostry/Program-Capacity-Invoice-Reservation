import { DomainError } from '../../../shared/domain/domain-error.js';
import type { Money } from '../../../shared/money/money.js';
import type { InvoiceId, ProgramId, RepaymentId } from '../domain/ids.js';

export class ProgramNotFoundError extends DomainError {
  readonly code = 'PROGRAM_NOT_FOUND';

  constructor(programId: ProgramId) {
    super(`Program ${programId.value} does not exist.`);
  }
}

/** Nothing to repay: the invoice was never reserved against the program, or is fully repaid. */
export class ReservationNotFoundError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(programId: ProgramId, invoiceId: InvoiceId) {
    super(
      `Invoice ${invoiceId.value} has no active reservation against program ${programId.value}.`,
    );
  }
}

/** The invoice already holds a reservation this request does not repeat, so it is not a retry. */
export class InvoiceAlreadyReservedError extends DomainError {
  readonly code = 'INVOICE_ALREADY_RESERVED';

  private constructor(message: string) {
    super(message);
  }

  /** The same invoice (and key, if any) for a different amount. */
  static forAmount(invoiceId: InvoiceId, reserved: Money, requested: Money) {
    return new InvoiceAlreadyReservedError(
      `Invoice ${invoiceId.value} is already reserved for ${reserved}; a request for ${requested} does not match it.`,
    );
  }

  /** A new key while the invoice still holds an active reservation. */
  static stillActive(invoiceId: InvoiceId) {
    return new InvoiceAlreadyReservedError(
      `Invoice ${invoiceId.value} still holds an active reservation; a new reservation key cannot be used until it is fully repaid.`,
    );
  }
}

/**
 * The invoice was reserved and fully repaid, and the request brings no new reservation key. It
 * may be a delayed retry of the original request, which must not hold capacity again.
 */
export class InvoiceAlreadyRepaidError extends DomainError {
  readonly code = 'INVOICE_ALREADY_REPAID';

  constructor(invoiceId: InvoiceId) {
    super(
      `Invoice ${invoiceId.value} was reserved and has been fully repaid. To reserve it again, send a new reservationKey.`,
    );
  }
}

/** A repayment id already applied, sent again with a different invoice or amount. */
export class RepaymentIdReusedError extends DomainError {
  readonly code = 'REPAYMENT_ID_REUSED';

  constructor(repaymentId: RepaymentId) {
    super(
      `Repayment ${repaymentId.value} was already applied with different details; a repayment id cannot be reused.`,
    );
  }
}

export class InvalidQueryError extends DomainError {
  readonly code = 'INVALID_QUERY';

  constructor(message: string) {
    super(message);
  }
}
