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
  StaleTreasuryUpdateError,
} from './errors.js';
import {
  CapacityDiscrepancyDetected,
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
} from './events.js';
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
  /** Highest treasury sequence applied; anything not newer is ignored (§13). */
  readonly treasurySequence: number;
}

/** A program's state as the treasury system reports it. */
export interface TreasuryState {
  /** Treasury owns the limit, and may set it below what is already reserved. */
  readonly creditLimit: Money;
  /**
   * Treasury's view of what is reserved, when the message carries one. Compared against ours
   * and reported if it differs; never written over ours.
   */
  readonly reportedReservedAmount: Money | null;
  /** Per-program, strictly increasing at the source. */
  readonly sequence: number;
  readonly at: Date;
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
 * A financing program's credit capacity — the aggregate that owns the rule that nothing may
 * be reserved beyond the credit limit.
 *
 * Reserved never goes below zero, and never rises above the limit through anything this
 * service does. It can sit *above* the limit only because treasury cut the limit under
 * existing holds (§4.5); the program is then over limit and takes no new reservations.
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
  #treasurySequence: number;

  private constructor(state: ProgramSnapshot) {
    super(state.id);
    this.#creditLimit = state.creditLimit;
    this.#reservedAmount = state.reservedAmount;
    this.#status = state.status;
    this.version = state.version;
    this.#treasurySequence = state.treasurySequence;
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
      treasurySequence: 0,
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

  get treasurySequence(): number {
    return this.#treasurySequence;
  }

  /**
   * Whether the program holds more than its current limit allows — only reachable when
   * treasury cuts a limit below what is already reserved. Available capacity is then
   * negative and every new reservation is refused until repayments bring it back under.
   */
  get isOverLimit(): boolean {
    return this.#reservedAmount.isGreaterThan(this.#creditLimit);
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

  /**
   * Applies the state treasury reports, which owns the credit limit.
   *
   * Rejects anything not newer than the sequence already applied: Kafka redelivers and can
   * reorder, so recognising that is routine rather than exceptional.
   */
  applyTreasuryState(state: TreasuryState): void {
    if (state.sequence <= this.#treasurySequence) {
      throw new StaleTreasuryUpdateError(this.id, this.#treasurySequence, state.sequence);
    }

    if (!state.creditLimit.currency.equals(this.currency)) {
      throw new InvariantViolationError(
        `Treasury reports a ${state.creditLimit.currency.code} limit for program ${this.id.value}, which is in ${this.currency.code}.`,
      );
    }

    if (!state.creditLimit.isPositive) {
      throw new InvalidAmountError(
        `A program's credit limit must be positive, received ${state.creditLimit}.`,
      );
    }

    const previousLimit = this.#creditLimit;
    this.#creditLimit = state.creditLimit;
    this.#treasurySequence = state.sequence;

    if (!previousLimit.equals(state.creditLimit)) {
      this.raise(
        new CreditLimitChanged({
          programId: this.id,
          previousLimit,
          creditLimit: state.creditLimit,
          reservedAmount: this.#reservedAmount,
          treasurySequence: state.sequence,
          occurredAt: state.at,
        }),
      );
    }

    this.reportAnyDiscrepancy(state);
  }

  toSnapshot(): ProgramSnapshot {
    return {
      id: this.id,
      creditLimit: this.#creditLimit,
      reservedAmount: this.#reservedAmount,
      status: this.#status,
      version: this.version,
      treasurySequence: this.#treasurySequence,
    };
  }

  /**
   * Reports, rather than repairs, a difference between treasury's view of what is reserved
   * and ours. Ours is explained by reservations and the ledger; theirs is a number we cannot
   * account for, and adopting it would break both the audit trail and the drift check.
   */
  private reportAnyDiscrepancy(state: TreasuryState): void {
    const reported = state.reportedReservedAmount;
    if (reported === null) return;

    if (!reported.currency.equals(this.currency)) {
      throw new InvariantViolationError(
        `Treasury reports ${reported.currency.code} reserved for program ${this.id.value}, which is in ${this.currency.code}.`,
      );
    }

    if (reported.equals(this.#reservedAmount)) return;

    this.raise(
      new CapacityDiscrepancyDetected({
        programId: this.id,
        reportedAmount: reported,
        reservedAmount: this.#reservedAmount,
        treasurySequence: state.sequence,
        occurredAt: state.at,
      }),
    );
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

  if (!Number.isSafeInteger(state.treasurySequence) || state.treasurySequence < 0) {
    throw new InvariantViolationError(
      `${subject} has an invalid treasury sequence ${state.treasurySequence}.`,
    );
  }

  // Deliberately no `reserved <= limit` check: a treasury limit cut below what is already
  // reserved leaves the program over limit, and existing holds stand (§4.5).
}
