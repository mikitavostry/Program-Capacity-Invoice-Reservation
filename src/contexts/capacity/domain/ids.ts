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

/** The caller's reference for one repayment; the idempotency key that makes retries safe. */
export class RepaymentId extends Identifier {
  static of(value: string): RepaymentId {
    return new RepaymentId(value);
  }
}

export class InvoiceId extends Identifier {
  static of(value: string): InvoiceId {
    return new InvoiceId(value);
  }
}
