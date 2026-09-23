import { Identifier } from '../../../shared/domain/identifier.js';

/**
 * What an id from another system may look like: 1–128 characters that need no escaping in a
 * URL. The HTTP API and the treasury feed both enforce it, so a program treasury opens can
 * always be addressed over HTTP.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const EXTERNAL_ID_RULE = "must be 1–128 characters of letters, digits, '.', '_', ':' or '-'";

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

/**
 * The caller's name for one reservation of an invoice. Optional on the first reservation; once
 * an invoice's reservation has been fully repaid, reserving it again needs a new key, so a
 * delayed retry of the original request cannot hold capacity a second time.
 */
export class ReservationKey extends Identifier {
  static of(value: string): ReservationKey {
    return new ReservationKey(value);
  }
}

export class InvoiceId extends Identifier {
  static of(value: string): InvoiceId {
    return new InvoiceId(value);
  }
}
