import { AggregateRoot } from '../../../shared/domain/aggregate-root.js';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation-error.js';
import type { Currency } from '../../../shared/money/currency.js';
import type { ExchangeRate } from '../../../shared/money/exchange-rate.js';
import { InvalidAmountError, Money } from '../../../shared/money/money.js';
import {
  ExchangeRateUnusableError,
  InsufficientCapacityError,
  ProgramNotActiveError,
  ReservationAlreadyReleasedError,
  ReservationProgramMismatchError,
} from './errors.js';
import { CapacityReleased, CapacityReserved, ProgramOpened } from './events.js';
import type { InvoiceId, ProgramId, RepaymentId, ReservationId } from './ids.js';
import { Reservation } from './reservation.js';

export const PROGRAM_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export interface ProgramSnapshot {
  readonly id: ProgramId;
  readonly creditLimit: Money;
  readonly reservedAmount: Money;
  readonly status: ProgramStatus;
  /** Optimistic concurrency token; the repository compares and increments it on save. */
  readonly version: number;
}

export interface ReserveCapacity {
  readonly reservationId: ReservationId;
  readonly invoiceId: InvoiceId;
  readonly invoiceAmount: Money;
  /** Required when the invoice is not in the program's currency; `null` otherwise. */
  readonly exchangeRate: ExchangeRate | null;
  readonly at: Date;
}

export interface ApplyRepayment {
  readonly repaymentId: RepaymentId;
  /** In the invoice's currency. `null` repays whatever is still outstanding. */
  readonly amount: Money | null;
  readonly at: Date;
}

/**
 * A financing program's credit capacity — the aggregate that owns the invariant
 * `0 ≤ reserved ≤ credit limit`.
 *
 * `reservedAmount` is a counter, deliberately denormalised from the active reservations so
 * the invariant can be checked without loading them. Every change to it goes through
 * `reserveFor` or `release`, which also produce or settle the matching `Reservation`, so
 * the counter and the records cannot be moved independently from inside the domain.
 */
export class Program extends AggregateRoot<ProgramId> {
  readonly version: number;

  #creditLimit: Money;
  #reservedAmount: Money;
  #status: ProgramStatus;

  private constructor(state: ProgramSnapshot) {
    super(state.id);
    this.#creditLimit = state.creditLimit;
    this.#reservedAmount = state.reservedAmount;
    this.#status = state.status;
    this.version = state.version;
  }

  static open(params: { id: ProgramId; creditLimit: Money; openedAt: Date }): Program {
    if (!params.creditLimit.isPositive) {
      throw new InvalidAmountError(
        `A program's credit limit must be positive, received ${params.creditLimit}.`,
      );
    }

    const program = new Program({
      id: params.id,
      creditLimit: params.creditLimit,
      reservedAmount: Money.zero(params.creditLimit.currency),
      status: 'ACTIVE',
      version: 0,
    });

    program.raise(new ProgramOpened(params.id, params.creditLimit, params.openedAt));

    return program;
  }

  static rehydrate(snapshot: ProgramSnapshot): Program {
    assertConsistent(snapshot);

    return new Program(snapshot);
  }

  get currency(): Currency {
    return this.#creditLimit.currency;
  }

  get creditLimit(): Money {
    return this.#creditLimit;
  }

  get reservedAmount(): Money {
    return this.#reservedAmount;
  }

  get availableCapacity(): Money {
    return this.#creditLimit.minus(this.#reservedAmount);
  }

  get status(): ProgramStatus {
    return this.#status;
  }

  /**
   * Holds capacity for an invoice and returns the reservation that records the hold.
   *
   * An invoice in another currency is converted at the supplied rate, rounding up, so the
   * figure checked against the limit is the figure held — rounding can never be what pushes
   * a program over its limit.
   */
  reserveFor(request: ReserveCapacity): Reservation {
    if (this.#status !== 'ACTIVE') {
      throw new ProgramNotActiveError(this.id, this.#status);
    }

    if (!request.invoiceAmount.isPositive) {
      throw new InvalidAmountError(
        `A reservation must be for a positive amount, received ${request.invoiceAmount}.`,
      );
    }

    const toHold = this.toProgramCurrency(request.invoiceAmount, request.exchangeRate);
    const available = this.availableCapacity;

    if (toHold.isGreaterThan(available)) {
      throw new InsufficientCapacityError(this.id, toHold, available);
    }

    // Built before the counter moves, so a rejected reservation leaves the program untouched.
    const reservation = Reservation.open({
      id: request.reservationId,
      programId: this.id,
      invoiceId: request.invoiceId,
      invoiceAmount: request.invoiceAmount,
      reservedAmount: toHold,
      exchangeRate: request.exchangeRate,
      reservedAt: request.at,
    });

    this.#reservedAmount = this.#reservedAmount.plus(toHold);

    this.raise(
      new CapacityReserved({
        programId: this.id,
        reservationId: reservation.id,
        invoiceId: reservation.invoiceId,
        invoiceAmount: reservation.invoiceAmount,
        reservedAmount: toHold,
        availableAfter: this.availableCapacity,
        occurredAt: request.at,
      }),
    );

    return reservation;
  }

  /**
   * Applies a repayment to one of this program's reservations and returns the capacity it
   * frees — some of the hold for a partial repayment, the rest of it for the final one.
   *
   * The amount freed comes from the reservation's stored reservation and rate, never a fresh
   * conversion. Repayments are accepted while the program is suspended: capacity that has
   * been repaid has to be freed, whatever the program's standing for new business.
   */
  release(reservation: Reservation, repayment: ApplyRepayment): Money {
    if (!reservation.programId.equals(this.id)) {
      throw new ReservationProgramMismatchError(reservation.id, this.id, reservation.programId);
    }

    if (reservation.isReleased) {
      throw new ReservationAlreadyReleasedError(reservation.id);
    }

    if (reservation.heldAmount.isGreaterThan(this.#reservedAmount)) {
      throw new InvariantViolationError(
        `Program ${this.id.value} holds ${this.#reservedAmount} in total but reservation ${reservation.id.value} alone holds ${reservation.heldAmount}; the counter has drifted from the reservations.`,
      );
    }

    const repaid = repayment.amount ?? reservation.outstandingAmount;
    const released = reservation.recordRepayment(repaid, repayment.at);

    this.#reservedAmount = this.#reservedAmount.minus(released);

    this.raise(
      new CapacityReleased({
        programId: this.id,
        reservationId: reservation.id,
        invoiceId: reservation.invoiceId,
        repaymentId: repayment.repaymentId,
        repaidAmount: repaid,
        releasedAmount: released,
        reservationFullyReleased: reservation.isReleased,
        availableAfter: this.availableCapacity,
        occurredAt: repayment.at,
      }),
    );

    return released;
  }

  toSnapshot(): ProgramSnapshot {
    return {
      id: this.id,
      creditLimit: this.#creditLimit,
      reservedAmount: this.#reservedAmount,
      status: this.#status,
      version: this.version,
    };
  }

  private toProgramCurrency(amount: Money, rate: ExchangeRate | null): Money {
    if (rate === null) {
      if (!amount.currency.equals(this.currency)) {
        throw ExchangeRateUnusableError.missing(amount.currency, this.currency);
      }

      return amount;
    }

    if (!rate.to.equals(this.currency)) {
      throw ExchangeRateUnusableError.wrongTarget(rate, this.currency);
    }

    return rate.convert(amount, 'CEILING');
  }
}

function assertConsistent(state: ProgramSnapshot): void {
  const subject = `Program ${state.id.value}`;

  if (!PROGRAM_STATUSES.includes(state.status)) {
    throw new InvariantViolationError(`${subject} has unknown status "${String(state.status)}".`);
  }

  if (!Number.isSafeInteger(state.version) || state.version < 0) {
    throw new InvariantViolationError(`${subject} has an invalid version ${state.version}.`);
  }

  if (!state.creditLimit.currency.equals(state.reservedAmount.currency)) {
    throw new InvariantViolationError(
      `${subject} has a ${state.creditLimit.currency.code} limit but ${state.reservedAmount.currency.code} reserved.`,
    );
  }

  if (state.creditLimit.isNegative || state.reservedAmount.isNegative) {
    throw new InvariantViolationError(`${subject} cannot hold a negative limit or reservation.`);
  }

  if (state.reservedAmount.isGreaterThan(state.creditLimit)) {
    throw new InvariantViolationError(
      `${subject} has ${state.reservedAmount} reserved against a limit of ${state.creditLimit}.`,
    );
  }
}
