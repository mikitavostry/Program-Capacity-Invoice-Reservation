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
  TreasuryCurrencyMismatchError,
} from './errors.js';
import {
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
  ProgramStatusChanged,
} from './events.js';
import type { InvoiceId, ProgramId, RepaymentId, ReservationId, ReservationKey } from './ids.js';
import { Reservation } from './reservation.js';

export const PROGRAM_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export interface ProgramSnapshot {
  readonly id: ProgramId;
  readonly creditLimit: Money;
  readonly reservedAmount: Money;
  readonly status: ProgramStatus;
  /** Row version, compared and incremented on save. */
  readonly version: number;
  /** Highest treasury sequence applied; anything not newer is ignored. */
  readonly treasurySequence: number;
}

/** What a treasury message says about a program. A `null` field leaves that field unchanged. */
export interface TreasuryState {
  /** May be below what is already reserved. */
  readonly creditLimit: Money | null;
  readonly sequence: number;
  readonly status?: ProgramStatus | null;
  readonly at: Date;
}

export interface ReserveCapacity {
  readonly reservationId: ReservationId;
  readonly invoiceId: InvoiceId;
  readonly reservationKey: ReservationKey | null;
  readonly invoiceAmount: Money;
  /** Invoice currency → program currency; `null` when they are the same. */
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
 * A financing program's credit capacity. Owns the rule that nothing is reserved beyond the
 * credit limit.
 *
 * `reservedAmount` is a counter kept beside the reservations so the check needs no scan; it
 * only moves through `reserveFor` and `release`, which also create or settle the reservation.
 * It can exceed the limit only when treasury cuts the limit below existing holds: the program
 * is then over limit and refuses new reservations until repayments bring it back under.
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

  static open(params: {
    id: ProgramId;
    creditLimit: Money;
    openedAt: Date;
    status?: ProgramStatus;
  }): Program {
    if (!params.creditLimit.isPositive) {
      throw new InvalidAmountError(
        `A program's credit limit must be positive, received ${params.creditLimit}.`,
      );
    }

    const program = new Program({
      id: params.id,
      creditLimit: params.creditLimit,
      reservedAmount: Money.zero(params.creditLimit.currency),
      status: params.status ?? 'ACTIVE',
      version: 0,
      treasurySequence: 0,
    });

    program.raise(
      new ProgramOpened(params.id, params.creditLimit, program.#status, params.openedAt),
    );

    return program;
  }

  /** Opens a program from treasury's first message for it; `ACTIVE` unless it says otherwise. */
  static openFromTreasury(
    id: ProgramId,
    state: TreasuryState & { readonly creditLimit: Money },
  ): Program {
    // The status goes into the opening event, so consumers never assume `ACTIVE`.
    const program = Program.open({
      id,
      creditLimit: state.creditLimit,
      openedAt: state.at,
      status: state.status ?? 'ACTIVE',
    });
    program.#treasurySequence = state.sequence;

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

  get isOverLimit(): boolean {
    return this.#reservedAmount.isGreaterThan(this.#creditLimit);
  }

  /**
   * Holds capacity for an invoice. An invoice in another currency is converted rounding up,
   * and the converted figure is both what is checked against the limit and what is held.
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
      reservationKey: request.reservationKey,
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
   * Applies a repayment and returns the capacity it frees, converted at the reservation's own
   * rate. Accepted while the program is suspended: repaid capacity is freed regardless.
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

    // Instances' clocks can disagree by a few milliseconds, so a repayment right after its
    // reservation may be stamped before it; it is recorded at the reservation's time instead.
    const at = new Date(Math.max(repayment.at.getTime(), reservation.reservedAt.getTime()));
    const repaid = repayment.amount ?? reservation.outstandingAmount;
    const released = reservation.recordRepayment(repaid, at);

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
        occurredAt: at,
      }),
    );

    return released;
  }

  applyTreasuryState(state: TreasuryState): void {
    if (state.sequence <= this.#treasurySequence) {
      throw new StaleTreasuryUpdateError(this.id, this.#treasurySequence, state.sequence);
    }

    const limit = state.creditLimit;

    if (limit !== null && !limit.currency.equals(this.currency)) {
      throw new TreasuryCurrencyMismatchError(this.id, limit.currency, this.currency);
    }

    if (limit !== null && !limit.isPositive) {
      throw new InvalidAmountError(`A program's credit limit must be positive, received ${limit}.`);
    }

    this.#treasurySequence = state.sequence;

    if (limit !== null && !limit.equals(this.#creditLimit)) {
      const previousLimit = this.#creditLimit;
      this.#creditLimit = limit;
      this.raise(
        new CreditLimitChanged({
          programId: this.id,
          previousLimit,
          creditLimit: limit,
          reservedAmount: this.#reservedAmount,
          treasurySequence: state.sequence,
          occurredAt: state.at,
        }),
      );
    }

    if (state.status != null && state.status !== this.#status) {
      const previousStatus = this.#status;
      this.#status = state.status;
      this.raise(
        new ProgramStatusChanged({
          programId: this.id,
          previousStatus,
          status: state.status,
          treasurySequence: state.sequence,
          occurredAt: state.at,
        }),
      );
    }
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

  // No `reserved <= limit` check: a treasury limit cut can leave a program over its limit.
}
