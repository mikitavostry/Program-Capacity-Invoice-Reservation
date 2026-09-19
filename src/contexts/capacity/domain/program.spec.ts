import { describe, expect, it } from 'vitest';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../shared/money/currency.js';
import { ExchangeRate, RateNotApplicableError } from '../../../shared/money/exchange-rate.js';
import { InvalidAmountError, Money } from '../../../shared/money/money.js';
import {
  ExchangeRateUnusableError,
  InsufficientCapacityError,
  ProgramNotActiveError,
  RepaymentCurrencyMismatchError,
  RepaymentExceedsOutstandingError,
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
import { InvoiceId, ProgramId, RepaymentId, ReservationId } from './ids.js';
import { Program, type ProgramSnapshot } from './program.js';
import { Reservation } from './reservation.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const GBP = Currency.of('GBP');

const OPENED_AT = new Date('2026-09-18T09:00:00.000Z');
const RESERVED_AT = new Date('2026-09-18T10:00:00.000Z');
const RELEASED_AT = new Date('2026-09-18T11:00:00.000Z');

const PROGRAM_ID = ProgramId.of('program-1');

const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);
const eurToUsd = (rate: string): ExchangeRate => ExchangeRate.of(EUR, USD, rate, RESERVED_AT);

function openProgram(limit = '10000000.00'): Program {
  const program = Program.open({ id: PROGRAM_ID, creditLimit: usd(limit), openedAt: OPENED_AT });
  program.pullDomainEvents();
  return program;
}

let sequence = 0;

function reserve(
  program: Program,
  amount: Money,
  exchangeRate: ExchangeRate | null = null,
): Reservation {
  sequence += 1;
  return program.reserveFor({
    reservationId: ReservationId.of(`reservation-${sequence}`),
    invoiceId: InvoiceId.of(`invoice-${sequence}`),
    invoiceAmount: amount,
    exchangeRate,
    at: RESERVED_AT,
  });
}

/** Applies a repayment; `null` repays whatever is outstanding. */
function repay(program: Program, reservation: Reservation, amount: Money | null = null): Money {
  sequence += 1;
  return program.release(reservation, {
    repaymentId: RepaymentId.of(`repayment-${sequence}`),
    amount,
    at: RELEASED_AT,
  });
}

function snapshot(overrides: Partial<ProgramSnapshot> = {}): ProgramSnapshot {
  return {
    id: PROGRAM_ID,
    creditLimit: usd('1000.00'),
    reservedAmount: usd('0.00'),
    status: 'ACTIVE',
    version: 3,
    treasurySequence: 0,
    ...overrides,
  };
}

describe('Program', () => {
  describe('opening', () => {
    it('starts with the whole limit available and nothing reserved', () => {
      const program = Program.open({
        id: PROGRAM_ID,
        creditLimit: usd('10000000.00'),
        openedAt: OPENED_AT,
      });

      expect(program.availableCapacity.equals(usd('10000000.00'))).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
      expect(program.currency).toBe(USD);
      expect(program.status).toBe('ACTIVE');
      expect(program.version).toBe(0);
    });

    it('records that it was opened', () => {
      const program = Program.open({
        id: PROGRAM_ID,
        creditLimit: usd('500.00'),
        openedAt: OPENED_AT,
      });
      const [event] = program.pullDomainEvents();

      expect(event).toBeInstanceOf(ProgramOpened);
      expect(event.aggregateId).toBe('program-1');
      expect((event as ProgramOpened).creditLimit.equals(usd('500.00'))).toBe(true);
    });

    it.each(['0.00', '-1.00'])('refuses a credit limit of %s', (limit) => {
      expect(() =>
        Program.open({ id: PROGRAM_ID, creditLimit: usd(limit), openedAt: OPENED_AT }),
      ).toThrow(InvalidAmountError);
    });
  });

  describe('reserving in the program currency', () => {
    it('holds the amount and reduces what is available by exactly that much', () => {
      const program = openProgram('1000.00');

      reserve(program, usd('250.00'));

      expect(program.reservedAmount.equals(usd('250.00'))).toBe(true);
      expect(program.availableCapacity.equals(usd('750.00'))).toBe(true);
    });

    it('returns an active reservation that needed no conversion', () => {
      const reservation = reserve(openProgram(), usd('250.00'));

      expect(reservation.isActive).toBe(true);
      expect(reservation.programId.equals(PROGRAM_ID)).toBe(true);
      expect(reservation.exchangeRate).toBeNull();
      expect(reservation.invoiceAmount.equals(usd('250.00'))).toBe(true);
      expect(reservation.reservedAmount.equals(usd('250.00'))).toBe(true);
      expect(reservation.reservedAt.toISOString()).toBe(RESERVED_AT.toISOString());
    });

    it('records the reservation along with what remains available', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));

      const [event] = program.pullDomainEvents() as CapacityReserved[];

      expect(event).toBeInstanceOf(CapacityReserved);
      expect(event.reservationId.equals(reservation.id)).toBe(true);
      expect(event.reservedAmount.equals(usd('250.00'))).toBe(true);
      expect(event.availableAfter.equals(usd('750.00'))).toBe(true);
    });

    it('accumulates across reservations', () => {
      const program = openProgram('1000.00');

      reserve(program, usd('100.00'));
      reserve(program, usd('200.00'));
      reserve(program, usd('300.00'));

      expect(program.availableCapacity.equals(usd('400.00'))).toBe(true);
    });

    it('allows reserving exactly what remains', () => {
      const program = openProgram('1000.00');
      reserve(program, usd('999.99'));

      reserve(program, usd('0.01'));

      expect(program.availableCapacity.isZero).toBe(true);
    });

    it('refuses even one minor unit more than remains', () => {
      const program = openProgram('1000.00');
      reserve(program, usd('999.99'));

      expect(() => reserve(program, usd('0.02'))).toThrow(InsufficientCapacityError);
    });

    it('leaves the program untouched when it refuses', () => {
      const program = openProgram('1000.00');
      reserve(program, usd('900.00'));
      program.pullDomainEvents();

      expect(() => reserve(program, usd('100.01'))).toThrow(
        /cannot reserve 100.01 USD: only 100.00 USD is available/,
      );
      expect(program.reservedAmount.equals(usd('900.00'))).toBe(true);
      expect(program.domainEvents).toHaveLength(0);
    });

    it('explains the refusal in structured form as well as in words', () => {
      const program = openProgram('100.00');

      try {
        reserve(program, usd('150.00'));
        expect.unreachable();
      } catch (error) {
        const refusal = error as InsufficientCapacityError;
        expect(refusal.code).toBe('INSUFFICIENT_CAPACITY');
        expect(refusal.requested.equals(usd('150.00'))).toBe(true);
        expect(refusal.available.equals(usd('100.00'))).toBe(true);
      }
    });

    it.each(['0.00', '-5.00'])('refuses to reserve %s', (amount) => {
      expect(() => reserve(openProgram(), usd(amount))).toThrow(InvalidAmountError);
    });
  });

  describe('reserving in another currency', () => {
    it('converts at the supplied rate and keeps the rate on the reservation', () => {
      const program = openProgram('1000.00');
      const rate = eurToUsd('1.09');

      const reservation = reserve(program, eur('100.00'), rate);

      expect(reservation.invoiceAmount.equals(eur('100.00'))).toBe(true);
      expect(reservation.reservedAmount.equals(usd('109.00'))).toBe(true);
      expect(reservation.exchangeRate?.equals(rate)).toBe(true);
      expect(program.availableCapacity.equals(usd('891.00'))).toBe(true);
    });

    it('rounds up, so rounding can never be what takes a program over its limit', () => {
      // 0.01 EUR at 1.095 is 0.01095 USD. Rounded to nearest it would fit in the last cent;
      // rounded up it needs two cents, and only one is left.
      const program = openProgram('1000.00');
      reserve(program, usd('999.99'));

      expect(() => reserve(program, eur('0.01'), eurToUsd('1.095'))).toThrow(
        InsufficientCapacityError,
      );
    });

    it('needs a rate to reserve an amount in a different currency', () => {
      expect(() => reserve(openProgram(), eur('100.00'))).toThrow(ExchangeRateUnusableError);
      expect(() => reserve(openProgram(), eur('100.00'))).toThrow(/needs a EUR\/USD rate/);
    });

    it('refuses a rate into a currency other than the program’s', () => {
      const rate = ExchangeRate.of(EUR, GBP, '0.85', RESERVED_AT);

      expect(() => reserve(openProgram(), eur('100.00'), rate)).toThrow(
        /EUR\/GBP rate cannot be used against a USD program/,
      );
    });

    it('refuses a rate out of a currency other than the invoice’s', () => {
      const rate = ExchangeRate.of(GBP, USD, '1.27', RESERVED_AT);

      expect(() => reserve(openProgram(), eur('100.00'), rate)).toThrow(RateNotApplicableError);
    });
  });

  describe('releasing in full', () => {
    it('frees exactly what was reserved and restores availability', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));

      const released = repay(program, reservation);

      expect(released.equals(usd('250.00'))).toBe(true);
      expect(program.availableCapacity.equals(usd('1000.00'))).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('frees the stored amount for a converted reservation rather than re-converting', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, eur('0.01'), eurToUsd('1.095'));

      const released = repay(program, reservation);

      // Exactly the rounded-up two cents that were held, so the counter returns to zero.
      expect(released.equals(usd('0.02'))).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('marks the reservation released at the time of the final repayment', () => {
      const program = openProgram();
      const reservation = reserve(program, usd('250.00'));

      repay(program, reservation);

      expect(reservation.isReleased).toBe(true);
      expect(reservation.heldAmount.isZero).toBe(true);
      expect(reservation.releasedAt?.toISOString()).toBe(RELEASED_AT.toISOString());
    });

    it('records the repayment, what it freed and what is available afterwards', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));
      program.pullDomainEvents();

      program.release(reservation, {
        repaymentId: RepaymentId.of('repayment-final'),
        amount: null,
        at: RELEASED_AT,
      });
      const [event] = program.pullDomainEvents() as CapacityReleased[];

      expect(event).toBeInstanceOf(CapacityReleased);
      expect(event.repaymentId.equals(RepaymentId.of('repayment-final'))).toBe(true);
      expect(event.repaidAmount.equals(usd('250.00'))).toBe(true);
      expect(event.releasedAmount.equals(usd('250.00'))).toBe(true);
      expect(event.reservationFullyReleased).toBe(true);
      expect(event.availableAfter.equals(usd('1000.00'))).toBe(true);
    });

    it('refuses a reservation that is already released, and frees nothing the second time', () => {
      const program = openProgram('1000.00');
      const first = reserve(program, usd('250.00'));
      reserve(program, usd('100.00'));
      repay(program, first);

      expect(() => repay(program, first)).toThrow(ReservationAlreadyReleasedError);
      expect(program.reservedAmount.equals(usd('100.00'))).toBe(true);
    });
  });

  describe('releasing in instalments', () => {
    it('frees each repaid share and keeps holding the rest', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));

      const released = repay(program, reservation, usd('100.00'));

      expect(released.equals(usd('100.00'))).toBe(true);
      expect(program.reservedAmount.equals(usd('150.00'))).toBe(true);
      expect(reservation.isActive).toBe(true);
      expect(reservation.heldAmount.equals(usd('150.00'))).toBe(true);
      expect(reservation.outstandingAmount.equals(usd('150.00'))).toBe(true);
      expect(reservation.releasedAt).toBeNull();
    });

    it('settles the remainder on the final instalment', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));
      repay(program, reservation, usd('100.00'));
      repay(program, reservation, usd('100.00'));

      const released = repay(program, reservation, usd('50.00'));

      expect(released.equals(usd('50.00'))).toBe(true);
      expect(reservation.isReleased).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('reports whether each instalment finished the reservation off', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));
      program.pullDomainEvents();

      repay(program, reservation, usd('100.00'));
      repay(program, reservation);
      const events = program.pullDomainEvents() as CapacityReleased[];

      expect(events.map((event) => event.reservationFullyReleased)).toEqual([false, true]);
      expect(events.map((event) => event.releasedAmount.toDecimalString())).toEqual([
        '100.00',
        '150.00',
      ]);
    });

    it('converts instalments at the stored rate', () => {
      // 100.00 EUR at 1.09 held 109.00 USD. 40.00 EUR of it is worth exactly 43.60 USD.
      const program = openProgram('1000.00');
      const reservation = reserve(program, eur('100.00'), eurToUsd('1.09'));

      expect(repay(program, reservation, eur('40.00')).equals(usd('43.60'))).toBe(true);
      expect(repay(program, reservation).equals(usd('65.40'))).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('never lets rounding make instalments free more or less than was held', () => {
      // 0.03 EUR at 1.095 is 0.03285 USD, held as 0.04 after rounding up. Each 0.01 EUR
      // instalment is worth 0.01095 USD; partial releases round down, and the last one
      // settles the difference, so the three releases sum to exactly the 0.04 held.
      const program = openProgram('1000.00');
      const reservation = reserve(program, eur('0.03'), eurToUsd('1.095'));
      expect(reservation.reservedAmount.equals(usd('0.04'))).toBe(true);

      const releases = [
        repay(program, reservation, eur('0.01')),
        repay(program, reservation, eur('0.01')),
        repay(program, reservation, eur('0.01')),
      ];

      expect(releases.map((released) => released.toDecimalString())).toEqual([
        '0.01',
        '0.01',
        '0.02',
      ]);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('can free nothing for an instalment worth less than a minor unit, then catch up', () => {
      // At 0.5, 0.01 EUR is worth half a US cent, which rounds down to nothing.
      const program = openProgram('1000.00');
      const reservation = reserve(program, eur('1.00'), eurToUsd('0.5'));
      program.pullDomainEvents();

      const first = repay(program, reservation, eur('0.01'));
      const [event] = program.pullDomainEvents() as CapacityReleased[];

      expect(first.isZero).toBe(true);
      expect(event.repaidAmount.equals(eur('0.01'))).toBe(true);
      expect(reservation.repaidAmount.equals(eur('0.01'))).toBe(true);
      expect(program.reservedAmount.equals(usd('0.50'))).toBe(true);

      expect(repay(program, reservation).equals(usd('0.50'))).toBe(true);
      expect(program.reservedAmount.isZero).toBe(true);
    });

    it('refuses a repayment larger than what is outstanding, and changes nothing', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));
      repay(program, reservation, usd('200.00'));

      expect(() => repay(program, reservation, usd('50.01'))).toThrow(
        RepaymentExceedsOutstandingError,
      );
      expect(program.reservedAmount.equals(usd('50.00'))).toBe(true);
      expect(reservation.outstandingAmount.equals(usd('50.00'))).toBe(true);
    });

    it('refuses a repayment in a currency other than the invoice’s', () => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, eur('100.00'), eurToUsd('1.09'));

      // The program is in USD, but the invoice is owed in EUR.
      expect(() => repay(program, reservation, usd('10.00'))).toThrow(
        RepaymentCurrencyMismatchError,
      );
    });

    it.each(['0.00', '-1.00'])('refuses a repayment of %s', (amount) => {
      const program = openProgram('1000.00');
      const reservation = reserve(program, usd('250.00'));

      expect(() => repay(program, reservation, usd(amount))).toThrow(InvalidAmountError);
    });
  });

  describe('guarding the counter on release', () => {
    it('refuses a reservation that belongs to another program', () => {
      const other = Program.open({
        id: ProgramId.of('program-2'),
        creditLimit: usd('1000.00'),
        openedAt: OPENED_AT,
      });
      const foreign = reserve(other, usd('100.00'));

      expect(() => repay(openProgram(), foreign)).toThrow(ReservationProgramMismatchError);
      expect(foreign.isActive).toBe(true);
    });

    it('fails loudly if the counter no longer covers what the reservation holds', () => {
      const reservation = reserve(openProgram(), usd('500.00'));
      const drifted = Program.rehydrate(snapshot({ reservedAmount: usd('100.00') }));

      expect(() => repay(drifted, reservation, usd('10.00'))).toThrow(InvariantViolationError);
      expect(reservation.repaidAmount.isZero).toBe(true);
    });
  });

  describe('when suspended', () => {
    const suspended = (): Program =>
      Program.rehydrate(snapshot({ status: 'SUSPENDED', reservedAmount: usd('250.00') }));

    it('refuses new reservations', () => {
      expect(() => reserve(suspended(), usd('10.00'))).toThrow(ProgramNotActiveError);
    });

    it('still accepts repayments, because repaid capacity must be freed', () => {
      const program = suspended();
      const reservation = Reservation.rehydrate({
        id: ReservationId.of('existing'),
        programId: PROGRAM_ID,
        invoiceId: InvoiceId.of('invoice-existing'),
        invoiceAmount: usd('250.00'),
        reservedAmount: usd('250.00'),
        exchangeRate: null,
        repaidAmount: usd('0.00'),
        releasedAmount: usd('0.00'),
        status: 'ACTIVE',
        reservedAt: RESERVED_AT,
        releasedAt: null,
      });

      repay(program, reservation, usd('100.00'));
      repay(program, reservation);

      expect(program.reservedAmount.isZero).toBe(true);
    });
  });

  describe('treasury updates', () => {
    const TREASURY_AT = new Date('2026-09-20T08:00:00.000Z');

    const applyTreasury = (
      program: Program,
      creditLimit: Money,
      sequence: number,
      reportedReservedAmount: Money | null = null,
    ): void =>
      program.applyTreasuryState({
        creditLimit,
        reportedReservedAmount,
        sequence,
        at: TREASURY_AT,
      });

    it('adopts a new credit limit and records what changed', () => {
      const program = openProgram('1000.00');

      applyTreasury(program, usd('2500.00'), 7);
      const [event] = program.pullDomainEvents() as CreditLimitChanged[];

      expect(program.creditLimit.equals(usd('2500.00'))).toBe(true);
      expect(program.treasurySequence).toBe(7);
      expect(event).toBeInstanceOf(CreditLimitChanged);
      expect(event.previousLimit.equals(usd('1000.00'))).toBe(true);
      expect(event.creditLimit.equals(usd('2500.00'))).toBe(true);
      expect(event.overLimit).toBe(false);
    });

    it('records nothing when the limit is unchanged, but still moves the sequence on', () => {
      const program = openProgram('1000.00');

      applyTreasury(program, usd('1000.00'), 7);

      expect(program.treasurySequence).toBe(7);
      expect(program.domainEvents).toHaveLength(0);
    });

    it.each([
      ['older than', 3],
      ['the same as', 7],
    ])('refuses a message %s the sequence already applied', (_, sequence) => {
      const program = openProgram('1000.00');
      applyTreasury(program, usd('2000.00'), 7);
      program.pullDomainEvents();

      expect(() => applyTreasury(program, usd('9000.00'), sequence)).toThrow(
        StaleTreasuryUpdateError,
      );
      expect(program.creditLimit.equals(usd('2000.00'))).toBe(true);
    });

    it('refuses a limit in another currency, or one that is not positive', () => {
      const program = openProgram('1000.00');

      expect(() => applyTreasury(program, eur('2000.00'), 7)).toThrow(InvariantViolationError);
      expect(() => applyTreasury(program, usd('0.00'), 7)).toThrow(InvalidAmountError);
    });

    describe('when treasury cuts the limit below what is already reserved', () => {
      function overLimitProgram(): Program {
        const program = openProgram('1000.00');
        reserve(program, usd('800.00'));
        program.pullDomainEvents();
        applyTreasury(program, usd('500.00'), 7);
        return program;
      }

      it('keeps the existing holds and goes over limit rather than refusing treasury', () => {
        const program = overLimitProgram();

        expect(program.isOverLimit).toBe(true);
        expect(program.creditLimit.equals(usd('500.00'))).toBe(true);
        expect(program.reservedAmount.equals(usd('800.00'))).toBe(true);
        expect(program.availableCapacity.equals(usd('-300.00'))).toBe(true);
      });

      it('says so in the event it records', () => {
        const [event] = overLimitProgram().pullDomainEvents() as CreditLimitChanged[];

        expect(event.overLimit).toBe(true);
      });

      it('takes no new reservation, however small', () => {
        const program = overLimitProgram();

        expect(() => reserve(program, usd('0.01'))).toThrow(InsufficientCapacityError);
      });

      it('still accepts repayments, and lends again once back under the limit', () => {
        const program = openProgram('1000.00');
        const reservation = reserve(program, usd('800.00'));
        applyTreasury(program, usd('500.00'), 7);

        repay(program, reservation, usd('400.00'));

        expect(program.isOverLimit).toBe(false);
        expect(program.availableCapacity.equals(usd('100.00'))).toBe(true);
        expect(() => reserve(program, usd('100.00'))).not.toThrow();
      });
    });

    describe('reconciliation', () => {
      it('reports a difference between treasury’s view of what is reserved and ours', () => {
        const program = openProgram('1000.00');
        reserve(program, usd('250.00'));
        program.pullDomainEvents();

        applyTreasury(program, usd('1000.00'), 7, usd('300.00'));
        const [event] = program.pullDomainEvents() as CapacityDiscrepancyDetected[];

        expect(event).toBeInstanceOf(CapacityDiscrepancyDetected);
        expect(event.reportedAmount.equals(usd('300.00'))).toBe(true);
        expect(event.reservedAmount.equals(usd('250.00'))).toBe(true);
        expect(event.difference.equals(usd('50.00'))).toBe(true);
      });

      it('does not adopt the reported figure: ours stays the one backed by the ledger', () => {
        const program = openProgram('1000.00');
        reserve(program, usd('250.00'));

        applyTreasury(program, usd('1000.00'), 7, usd('300.00'));

        expect(program.reservedAmount.equals(usd('250.00'))).toBe(true);
      });

      it('says nothing when the two agree', () => {
        const program = openProgram('1000.00');
        reserve(program, usd('250.00'));
        program.pullDomainEvents();

        applyTreasury(program, usd('1000.00'), 7, usd('250.00'));

        expect(program.domainEvents).toHaveLength(0);
      });

      it('refuses a reported amount in another currency', () => {
        const program = openProgram('1000.00');

        expect(() => applyTreasury(program, usd('1000.00'), 7, eur('250.00'))).toThrow(
          InvariantViolationError,
        );
      });
    });
  });

  describe('rehydrating', () => {
    it('restores a program that is over its limit, which treasury can cause', () => {
      const program = Program.rehydrate(
        snapshot({ creditLimit: usd('500.00'), reservedAmount: usd('800.00') }),
      );

      expect(program.isOverLimit).toBe(true);
      expect(program.availableCapacity.equals(usd('-300.00'))).toBe(true);
    });

    it('refuses a negative treasury sequence', () => {
      expect(() => Program.rehydrate(snapshot({ treasurySequence: -1 }))).toThrow(
        InvariantViolationError,
      );
    });

    it('restores state without recording any events', () => {
      const program = Program.rehydrate(snapshot({ reservedAmount: usd('400.00'), version: 7 }));

      expect(program.availableCapacity.equals(usd('600.00'))).toBe(true);
      expect(program.version).toBe(7);
      expect(program.domainEvents).toHaveLength(0);
    });

    it('round-trips through a snapshot', () => {
      const original = snapshot({ reservedAmount: usd('400.00') });

      expect(Program.rehydrate(original).toSnapshot()).toEqual(original);
    });

    it.each<[string, Partial<ProgramSnapshot>]>([
      ['a negative reservation', { reservedAmount: usd('-1.00') }],
      ['a negative limit', { creditLimit: usd('-1.00') }],
      ['a reservation in another currency', { reservedAmount: eur('0.00') }],
      ['a negative version', { version: -1 }],
      ['a fractional version', { version: 1.5 }],
      ['an unknown status', { status: 'CLOSED' as ProgramSnapshot['status'] }],
    ])('refuses stored state with %s', (_, overrides) => {
      expect(() => Program.rehydrate(snapshot(overrides))).toThrow(InvariantViolationError);
    });
  });
});
