import { AggregateRoot } from '../../../shared/domain/aggregate-root.js';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation-error.js';
import type { ExchangeRate } from '../../../shared/money/exchange-rate.js';
import { InvalidAmountError, Money } from '../../../shared/money/money.js';
import {
  RepaymentCurrencyMismatchError,
  RepaymentExceedsOutstandingError,
  ReservationAlreadyReleasedError,
} from './errors.js';
import type { InvoiceId, ProgramId, ReservationId, ReservationKey } from './ids.js';

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface ReservationSnapshot {
  readonly id: ReservationId;
  readonly programId: ProgramId;
  readonly invoiceId: InvoiceId;
  /** The caller's key for this reservation of the invoice; `null` when none was sent. */
  readonly reservationKey: ReservationKey | null;
  /** The amount as the invoice states it, in the invoice's currency. */
  readonly invoiceAmount: Money;
  /** The capacity held against the program when the reservation was made, in its currency. */
  readonly reservedAmount: Money;
  /** Invoice currency → program currency; `null` when they are the same. */
  readonly exchangeRate: ExchangeRate | null;
  /** Repaid so far, in the invoice's currency. */
  readonly repaidAmount: Money;
  /** Capacity freed so far, in the program's currency. */
  readonly releasedAmount: Money;
  /** `ACTIVE` while any of the invoice is outstanding; `RELEASED` once it is fully repaid. */
  readonly status: ReservationStatus;
  readonly reservedAt: Date;
  /** When the final repayment arrived; `null` until then. */
  readonly releasedAt: Date | null;
}

export type NewReservation = Omit<
  ReservationSnapshot,
  'repaidAmount' | 'releasedAmount' | 'status' | 'releasedAt'
>;

/**
 * One invoice's hold on a program's capacity, and the repayments that wind it down.
 *
 * Each release is computed from the running total repaid, rounding down, and the final
 * repayment frees exactly what is left, so the total released equals the total reserved to
 * the minor unit however the repayments were split. Create and repay reservations through
 * `Program`, which keeps its counter in step.
 */
export class Reservation extends AggregateRoot<ReservationId> {
  readonly programId: ProgramId;
  readonly invoiceId: InvoiceId;
  readonly reservationKey: ReservationKey | null;
  readonly invoiceAmount: Money;
  readonly reservedAmount: Money;
  readonly exchangeRate: ExchangeRate | null;

  #repaidAmount: Money;
  #releasedAmount: Money;
  #status: ReservationStatus;
  #reservedAtMillis: number;
  #releasedAtMillis: number | null;

  private constructor(state: ReservationSnapshot) {
    super(state.id);
    this.programId = state.programId;
    this.invoiceId = state.invoiceId;
    this.reservationKey = state.reservationKey;
    this.invoiceAmount = state.invoiceAmount;
    this.reservedAmount = state.reservedAmount;
    this.exchangeRate = state.exchangeRate;
    this.#repaidAmount = state.repaidAmount;
    this.#releasedAmount = state.releasedAmount;
    this.#status = state.status;
    this.#reservedAtMillis = state.reservedAt.getTime();
    this.#releasedAtMillis = state.releasedAt === null ? null : state.releasedAt.getTime();
  }

  static open(params: NewReservation): Reservation {
    const state: ReservationSnapshot = {
      ...params,
      repaidAmount: Money.zero(params.invoiceAmount.currency),
      releasedAmount: Money.zero(params.reservedAmount.currency),
      status: 'ACTIVE',
      releasedAt: null,
    };
    assertConsistent(state);

    return new Reservation(state);
  }

  static rehydrate(snapshot: ReservationSnapshot): Reservation {
    assertConsistent(snapshot);

    return new Reservation(snapshot);
  }

  get status(): ReservationStatus {
    return this.#status;
  }

  get isActive(): boolean {
    return this.#status === 'ACTIVE';
  }

  get isReleased(): boolean {
    return this.#status === 'RELEASED';
  }

  get repaidAmount(): Money {
    return this.#repaidAmount;
  }

  get releasedAmount(): Money {
    return this.#releasedAmount;
  }

  /** What is still owed on the invoice, in the invoice's currency. */
  get outstandingAmount(): Money {
    return this.invoiceAmount.minus(this.#repaidAmount);
  }

  /** Capacity this reservation is still holding, in the program's currency. */
  get heldAmount(): Money {
    return this.reservedAmount.minus(this.#releasedAmount);
  }

  get reservedAt(): Date {
    return new Date(this.#reservedAtMillis);
  }

  get releasedAt(): Date | null {
    return this.#releasedAtMillis === null ? null : new Date(this.#releasedAtMillis);
  }

  /**
   * Applies a repayment in the invoice's currency and returns the capacity it frees in the
   * program's; zero for an instalment worth less than one minor unit after conversion.
   */
  recordRepayment(repayment: Money, at: Date): Money {
    if (this.#status === 'RELEASED') {
      throw new ReservationAlreadyReleasedError(this.id);
    }

    if (!repayment.currency.equals(this.invoiceAmount.currency)) {
      throw new RepaymentCurrencyMismatchError(
        this.invoiceId,
        this.invoiceAmount.currency,
        repayment.currency,
      );
    }

    if (!repayment.isPositive) {
      throw new InvalidAmountError(`A repayment must be positive, received ${repayment}.`);
    }

    const outstanding = this.outstandingAmount;
    if (repayment.isGreaterThan(outstanding)) {
      throw new RepaymentExceedsOutstandingError(this.invoiceId, repayment, outstanding);
    }

    const atMillis = validTime(at, 'repayment time');
    if (atMillis < this.#reservedAtMillis) {
      throw new InvariantViolationError(
        `Reservation ${this.id.value} cannot be repaid before it was made.`,
      );
    }

    const repaidAfter = this.#repaidAmount.plus(repayment);
    const releasedAfter = this.capacityReleasedOnceRepaid(repaidAfter);
    const releasedNow = releasedAfter.minus(this.#releasedAmount);

    this.#repaidAmount = repaidAfter;
    this.#releasedAmount = releasedAfter;

    if (repaidAfter.equals(this.invoiceAmount)) {
      this.#status = 'RELEASED';
      this.#releasedAtMillis = atMillis;
    }

    return releasedNow;
  }

  toSnapshot(): ReservationSnapshot {
    return {
      id: this.id,
      programId: this.programId,
      invoiceId: this.invoiceId,
      reservationKey: this.reservationKey,
      invoiceAmount: this.invoiceAmount,
      reservedAmount: this.reservedAmount,
      exchangeRate: this.exchangeRate,
      repaidAmount: this.#repaidAmount,
      releasedAmount: this.#releasedAmount,
      status: this.#status,
      reservedAt: this.reservedAt,
      releasedAt: this.releasedAt,
    };
  }

  /** Total capacity freed once `repaid` is repaid; rounding never accumulates per instalment. */
  private capacityReleasedOnceRepaid(repaid: Money): Money {
    if (repaid.equals(this.invoiceAmount)) return this.reservedAmount;
    if (this.exchangeRate === null) return repaid;

    return this.exchangeRate.convert(repaid, 'FLOOR');
  }
}

function validTime(value: Date, label: string): number {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvariantViolationError(`A reservation's ${label} must be a valid date.`);
  }

  return value.getTime();
}

function assertConsistent(state: ReservationSnapshot): void {
  const subject = `Reservation ${state.id.value}`;

  if (!RESERVATION_STATUSES.includes(state.status)) {
    throw new InvariantViolationError(`${subject} has unknown status "${String(state.status)}".`);
  }

  if (!state.invoiceAmount.isPositive || !state.reservedAmount.isPositive) {
    throw new InvariantViolationError(`${subject} must hold a positive amount.`);
  }

  const rate = state.exchangeRate;
  if (rate === null) {
    if (!state.invoiceAmount.equals(state.reservedAmount)) {
      throw new InvariantViolationError(
        `${subject} has no exchange rate, so its reserved amount must equal the invoice amount.`,
      );
    }
  } else if (
    !rate.from.equals(state.invoiceAmount.currency) ||
    !rate.to.equals(state.reservedAmount.currency)
  ) {
    throw new InvariantViolationError(
      `${subject} converts ${state.invoiceAmount.currency.code} into ${state.reservedAmount.currency.code} but carries a ${rate.from.code}/${rate.to.code} rate.`,
    );
  }

  if (
    !state.repaidAmount.currency.equals(state.invoiceAmount.currency) ||
    !state.releasedAmount.currency.equals(state.reservedAmount.currency)
  ) {
    throw new InvariantViolationError(
      `${subject} records repayments or releases in the wrong currency.`,
    );
  }

  if (state.repaidAmount.isNegative || state.repaidAmount.isGreaterThan(state.invoiceAmount)) {
    throw new InvariantViolationError(
      `${subject} has ${state.repaidAmount} repaid against an invoice for ${state.invoiceAmount}.`,
    );
  }

  if (state.releasedAmount.isNegative || state.releasedAmount.isGreaterThan(state.reservedAmount)) {
    throw new InvariantViolationError(
      `${subject} has released ${state.releasedAmount} of the ${state.reservedAmount} it held.`,
    );
  }

  if (rate === null && !state.repaidAmount.equals(state.releasedAmount)) {
    throw new InvariantViolationError(
      `${subject} has no exchange rate, so what it released must equal what was repaid.`,
    );
  }

  const fullyRepaid = state.repaidAmount.equals(state.invoiceAmount);

  if (fullyRepaid !== (state.status === 'RELEASED')) {
    throw new InvariantViolationError(
      `${subject} is ${state.status} but has ${state.repaidAmount} of ${state.invoiceAmount} repaid.`,
    );
  }

  if (fullyRepaid && !state.releasedAmount.equals(state.reservedAmount)) {
    throw new InvariantViolationError(
      `${subject} is fully repaid but has released only ${state.releasedAmount} of ${state.reservedAmount}.`,
    );
  }

  const reservedAtMillis = validTime(state.reservedAt, 'reservation time');

  if (state.status === 'ACTIVE' && state.releasedAt !== null) {
    throw new InvariantViolationError(`${subject} is active but has a release time.`);
  }

  if (state.status === 'RELEASED') {
    if (state.releasedAt === null) {
      throw new InvariantViolationError(`${subject} is released but has no release time.`);
    }
    if (validTime(state.releasedAt, 'release time') < reservedAtMillis) {
      throw new InvariantViolationError(`${subject} was released before it was made.`);
    }
  }
}
