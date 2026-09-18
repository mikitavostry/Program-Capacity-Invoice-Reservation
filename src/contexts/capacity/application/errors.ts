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

/**
 * A reservation request for an invoice that already holds one, for a different amount.
 *
 * The same amount is treated as a retry and answered with the existing reservation. A
 * different one cannot be a retry — it is either a mistake or a change the caller should
 * make explicitly — so it is refused rather than guessed at.
 */
export class InvoiceAlreadyReservedError extends DomainError {
  readonly code = 'INVOICE_ALREADY_RESERVED';

  constructor(invoiceId: InvoiceId, reserved: Money, requested: Money) {
    super(
      `Invoice ${invoiceId.value} already has an active reservation for ${reserved}; a new request for ${requested} does not match it.`,
    );
  }
}

/**
 * A repayment id that was already applied, sent again with a different invoice or amount.
 *
 * An exact replay is answered with the original outcome. A mismatched one means the caller
 * reused an id it should not have, and silently applying — or silently ignoring — the new
 * amount would each lose money somewhere.
 */
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
