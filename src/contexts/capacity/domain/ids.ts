import { Identifier } from '../../../shared/domain/identifier.js';

export class ProgramId extends Identifier {
  static of(value: string): ProgramId {
    return new ProgramId(value);
  }
}

export class ReservationId extends Identifier {
  static of(value: string): ReservationId {
    return new ReservationId(value);
  }
}

/**
 * The upstream reference for one repayment against an invoice.
 *
 * It doubles as the idempotency key for the release it triggers. A full release is
 * naturally idempotent — a second attempt finds nothing left to release — but a partial one
 * is not: "release 40" replayed would release 80. Recording which repayments have already
 * been applied is what makes a retry safe.
 */
export class RepaymentId extends Identifier {
  static of(value: string): RepaymentId {
    return new RepaymentId(value);
  }
}

/**
 * A reference to an invoice owned by the upstream invoicing context.
 *
 * We hold the id and nothing else: whether the invoice is approved, disputed or paid is not
 * this context's concern. We are told to reserve against it and told to release it.
 */
export class InvoiceId extends Identifier {
  static of(value: string): InvoiceId {
    return new InvoiceId(value);
  }
}
