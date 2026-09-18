import { describe, expect, it } from 'vitest';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../shared/money/currency.js';
import { ExchangeRate } from '../../../shared/money/exchange-rate.js';
import { Money } from '../../../shared/money/money.js';
import {
  RepaymentCurrencyMismatchError,
  RepaymentExceedsOutstandingError,
  ReservationAlreadyReleasedError,
} from './errors.js';
import { InvoiceId, ProgramId, ReservationId } from './ids.js';
import { Reservation, type ReservationSnapshot } from './reservation.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');

const RESERVED_AT = new Date('2026-09-18T10:00:00.000Z');
const REPAID_AT = new Date('2026-09-18T11:00:00.000Z');

const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);
const eurToUsd = ExchangeRate.of(EUR, USD, '1.09', RESERVED_AT);

function snapshot(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return {
    id: ReservationId.of('reservation-1'),
    programId: ProgramId.of('program-1'),
    invoiceId: InvoiceId.of('invoice-1'),
    invoiceAmount: usd('250.00'),
    reservedAmount: usd('250.00'),
    exchangeRate: null,
    repaidAmount: usd('0.00'),
    releasedAmount: usd('0.00'),
    status: 'ACTIVE',
    reservedAt: RESERVED_AT,
    releasedAt: null,
    ...overrides,
  };
}

function converted(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return snapshot({
    invoiceAmount: eur('100.00'),
    reservedAmount: usd('109.00'),
    exchangeRate: eurToUsd,
    repaidAmount: eur('0.00'),
    releasedAmount: usd('0.00'),
    ...overrides,
  });
}

describe('Reservation', () => {
  describe('opening', () => {
    it('starts with nothing repaid and everything still held', () => {
      const reservation = Reservation.open({
        id: ReservationId.of('reservation-1'),
        programId: ProgramId.of('program-1'),
        invoiceId: InvoiceId.of('invoice-1'),
        invoiceAmount: eur('100.00'),
        reservedAmount: usd('109.00'),
        exchangeRate: eurToUsd,
        reservedAt: RESERVED_AT,
      });

      expect(reservation.isActive).toBe(true);
      expect(reservation.repaidAmount.equals(eur('0.00'))).toBe(true);
      expect(reservation.outstandingAmount.equals(eur('100.00'))).toBe(true);
      expect(reservation.heldAmount.equals(usd('109.00'))).toBe(true);
    });
  });

  describe('recording repayments', () => {
    it('frees the whole hold when repaid in full', () => {
      const reservation = Reservation.rehydrate(snapshot());

      expect(reservation.recordRepayment(usd('250.00'), REPAID_AT).equals(usd('250.00'))).toBe(
        true,
      );
      expect(reservation.isReleased).toBe(true);
      expect(reservation.status).toBe('RELEASED');
      expect(reservation.releasedAt?.toISOString()).toBe(REPAID_AT.toISOString());
    });

    it('frees part of the hold for a partial repayment and stays active', () => {
      const reservation = Reservation.rehydrate(snapshot());

      expect(reservation.recordRepayment(usd('100.00'), REPAID_AT).equals(usd('100.00'))).toBe(
        true,
      );
      expect(reservation.isActive).toBe(true);
      expect(reservation.outstandingAmount.equals(usd('150.00'))).toBe(true);
      expect(reservation.heldAmount.equals(usd('150.00'))).toBe(true);
      expect(reservation.releasedAt).toBeNull();
    });

    it('carries on from a partially repaid state loaded from storage', () => {
      const reservation = Reservation.rehydrate(
        converted({ repaidAmount: eur('40.00'), releasedAmount: usd('43.60') }),
      );

      expect(reservation.recordRepayment(eur('60.00'), REPAID_AT).equals(usd('65.40'))).toBe(true);
      expect(reservation.isReleased).toBe(true);
    });

    it('refuses anything once fully released', () => {
      const reservation = Reservation.rehydrate(snapshot());
      reservation.recordRepayment(usd('250.00'), REPAID_AT);

      expect(() => reservation.recordRepayment(usd('1.00'), REPAID_AT)).toThrow(
        ReservationAlreadyReleasedError,
      );
    });

    it('refuses more than is outstanding', () => {
      const reservation = Reservation.rehydrate(snapshot());

      expect(() => reservation.recordRepayment(usd('250.01'), REPAID_AT)).toThrow(
        RepaymentExceedsOutstandingError,
      );
      expect(() => reservation.recordRepayment(usd('250.01'), REPAID_AT)).toThrow(
        /250.00 USD outstanding/,
      );
    });

    it('refuses a repayment in the program currency when the invoice is in another', () => {
      const reservation = Reservation.rehydrate(converted());

      expect(() => reservation.recordRepayment(usd('10.00'), REPAID_AT)).toThrow(
        RepaymentCurrencyMismatchError,
      );
    });

    it('cannot be repaid before it was made', () => {
      const reservation = Reservation.rehydrate(snapshot());

      expect(() =>
        reservation.recordRepayment(usd('10.00'), new Date('2026-09-18T09:59:59.999Z')),
      ).toThrow(InvariantViolationError);
      expect(reservation.repaidAmount.isZero).toBe(true);
    });

    it('refuses an invalid repayment time', () => {
      expect(() =>
        Reservation.rehydrate(snapshot()).recordRepayment(usd('10.00'), new Date('nonsense')),
      ).toThrow(/must be a valid date/);
    });
  });

  describe('its timeline', () => {
    it('cannot be altered through the Dates it was built from or hands back', () => {
      const reservedAt = new Date(RESERVED_AT);
      const reservation = Reservation.rehydrate(snapshot({ reservedAt }));

      reservedAt.setFullYear(1999);
      reservation.reservedAt.setFullYear(1999);

      expect(reservation.reservedAt.toISOString()).toBe(RESERVED_AT.toISOString());
    });
  });

  describe('rehydrating', () => {
    it('accepts a fully released reservation with a consistent timeline', () => {
      const reservation = Reservation.rehydrate(
        snapshot({
          repaidAmount: usd('250.00'),
          releasedAmount: usd('250.00'),
          status: 'RELEASED',
          releasedAt: REPAID_AT,
        }),
      );

      expect(reservation.isReleased).toBe(true);
    });

    it('accepts a converted reservation part-way through repayment', () => {
      const reservation = Reservation.rehydrate(
        converted({ repaidAmount: eur('40.00'), releasedAmount: usd('43.60') }),
      );

      expect(reservation.heldAmount.equals(usd('65.40'))).toBe(true);
    });

    it('round-trips through a snapshot', () => {
      const original = converted({ repaidAmount: eur('40.00'), releasedAmount: usd('43.60') });

      expect(Reservation.rehydrate(original).toSnapshot()).toEqual(original);
    });

    it.each<[string, Partial<ReservationSnapshot>]>([
      [
        'a zero amount',
        {
          invoiceAmount: usd('0.00'),
          reservedAmount: usd('0.00'),
        },
      ],
      ['amounts that differ with no rate to explain them', { reservedAmount: usd('260.00') }],
      [
        'amounts in different currencies with no rate',
        { invoiceAmount: eur('250.00'), repaidAmount: eur('0.00') },
      ],
      [
        'a rate that does not connect its two currencies',
        {
          invoiceAmount: eur('100.00'),
          reservedAmount: usd('109.00'),
          repaidAmount: eur('0.00'),
          exchangeRate: ExchangeRate.of(USD, EUR, '0.92', RESERVED_AT),
        },
      ],
      ['repayments in the wrong currency', { repaidAmount: eur('0.00') }],
      ['more repaid than invoiced', { repaidAmount: usd('250.01'), releasedAmount: usd('250.01') }],
      ['a negative repayment', { repaidAmount: usd('-1.00'), releasedAmount: usd('-1.00') }],
      ['released and repaid out of step with no rate', { repaidAmount: usd('100.00') }],
      [
        'full repayment still marked active',
        { repaidAmount: usd('250.00'), releasedAmount: usd('250.00') },
      ],
      [
        'released status without full repayment',
        {
          repaidAmount: usd('100.00'),
          releasedAmount: usd('100.00'),
          status: 'RELEASED',
          releasedAt: REPAID_AT,
        },
      ],
      ['an active status with a release time', { releasedAt: REPAID_AT }],
      [
        'a release before the reservation',
        {
          repaidAmount: usd('250.00'),
          releasedAmount: usd('250.00'),
          status: 'RELEASED',
          releasedAt: new Date('2026-09-18T09:00:00.000Z'),
        },
      ],
      ['an invalid reservation time', { reservedAt: new Date('nonsense') }],
      ['an unknown status', { status: 'PENDING' as ReservationSnapshot['status'] }],
    ])('refuses stored state with %s', (_, overrides) => {
      expect(() => Reservation.rehydrate(snapshot(overrides))).toThrow(InvariantViolationError);
    });

    it('refuses a fully repaid converted reservation that has not released everything it held', () => {
      expect(() =>
        Reservation.rehydrate(
          converted({
            repaidAmount: eur('100.00'),
            releasedAmount: usd('108.99'),
            status: 'RELEASED',
            releasedAt: REPAID_AT,
          }),
        ),
      ).toThrow(/fully repaid but has released only 108.99 USD of 109.00 USD/);
    });
  });
});
