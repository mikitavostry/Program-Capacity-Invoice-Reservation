import { describe, expect, it } from 'vitest';
import { Currency } from '../currency.js';
import { CurrencyMismatchError, InvalidAmountError, Money } from '../money.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const JPY = Currency.of('JPY');
const BHD = Currency.of('BHD');

describe('Money', () => {
  describe('fromDecimal', () => {
    it.each([
      ['1234.56', USD, 123456n],
      ['0.05', USD, 5n],
      ['-0.05', USD, -5n],
      ['10000000.00', USD, 1000000000n], // a $10m programme limit
      ['1234', JPY, 1234n], // no minor unit at all
      ['1.234', BHD, 1234n], // three decimal places
    ])('reads %s as %s minor units', (input, currency, expected) => {
      expect(Money.fromDecimal(input, currency).minorUnits).toBe(expected);
    });

    it('accepts a value with fewer decimal places than the currency allows', () => {
      expect(Money.fromDecimal('7', USD).minorUnits).toBe(700n);
      expect(Money.fromDecimal('7.5', USD).minorUnits).toBe(750n);
    });

    it('rejects precision the currency cannot hold, rather than truncating it', () => {
      expect(() => Money.fromDecimal('1.234', USD)).toThrow(InvalidAmountError);
      expect(() => Money.fromDecimal('1.234', USD)).toThrow(/at most 2 decimal places/);
      expect(() => Money.fromDecimal('12.5', JPY)).toThrow(/must be a whole number/);
    });

    it.each(['', 'abc', '1,234.56', '1.2.3', '+5', '1e3', ' '])(
      'rejects %s as an amount',
      (input) => {
        expect(() => Money.fromDecimal(input, USD)).toThrow(InvalidAmountError);
      },
    );

    it('stays exact well beyond the range of a double', () => {
      const huge = '99999999999999999999.99';

      expect(Money.fromDecimal(huge, USD).toDecimalString()).toBe(huge);
    });
  });

  describe('fromMinorUnits', () => {
    it('accepts a bigint or a safe integer', () => {
      expect(Money.fromMinorUnits(12345n, USD).minorUnits).toBe(12345n);
      expect(Money.fromMinorUnits(12345, USD).minorUnits).toBe(12345n);
    });

    it('rejects a fractional count of minor units', () => {
      expect(() => Money.fromMinorUnits(1.5, USD)).toThrow(InvalidAmountError);
    });

    it('rejects a number too large to be exact, pointing at bigint', () => {
      expect(() => Money.fromMinorUnits(2 ** 53, USD)).toThrow(/pass a bigint instead/);
    });
  });

  describe('formatting', () => {
    it.each([
      [123456n, USD, '1234.56'],
      [5n, USD, '0.05'],
      [0n, USD, '0.00'],
      [-5n, USD, '-0.05'],
      [1234n, JPY, '1234'],
      [1234n, BHD, '1.234'],
    ])('renders %s minor units as %s', (minorUnits, currency, expected) => {
      expect(Money.fromMinorUnits(minorUnits, currency).toDecimalString()).toBe(expected);
    });

    it('serialises as an amount and a currency, never a bare number', () => {
      expect(Money.fromDecimal('1234.56', USD).toJSON()).toEqual({
        amount: '1234.56',
        currency: 'USD',
      });
    });

    it('describes itself with its currency', () => {
      expect(String(Money.fromDecimal('10.00', USD))).toBe('10.00 USD');
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts within one currency', () => {
      const ten = Money.fromDecimal('10.00', USD);
      const three = Money.fromDecimal('3.00', USD);

      expect(ten.plus(three).toDecimalString()).toBe('13.00');
      expect(ten.minus(three).toDecimalString()).toBe('7.00');
    });

    it('allows a negative result, leaving range rules to the aggregate that owns them', () => {
      const result = Money.fromDecimal('3.00', USD).minus(Money.fromDecimal('10.00', USD));

      expect(result.toDecimalString()).toBe('-7.00');
      expect(result.isNegative).toBe(true);
    });

    it('refuses to combine different currencies', () => {
      const dollars = Money.fromDecimal('10.00', USD);
      const euros = Money.fromDecimal('10.00', EUR);

      expect(() => dollars.plus(euros)).toThrow(CurrencyMismatchError);
      expect(() => dollars.minus(euros)).toThrow(/Cannot combine an amount in USD with one in EUR/);
      expect(() => dollars.compareTo(euros)).toThrow(CurrencyMismatchError);
    });

    it('leaves the operands untouched', () => {
      const ten = Money.fromDecimal('10.00', USD);
      ten.plus(Money.fromDecimal('5.00', USD));

      expect(ten.toDecimalString()).toBe('10.00');
    });

    it('negates', () => {
      expect(Money.fromDecimal('10.00', USD).negated().toDecimalString()).toBe('-10.00');
    });
  });

  describe('comparison', () => {
    const five = Money.fromDecimal('5.00', USD);
    const ten = Money.fromDecimal('10.00', USD);

    it('orders amounts', () => {
      expect(five.isLessThan(ten)).toBe(true);
      expect(ten.isGreaterThan(five)).toBe(true);
      expect(five.isGreaterThan(ten)).toBe(false);
      expect(five.compareTo(ten)).toBe(-1);
      expect(ten.compareTo(five)).toBe(1);
      expect(five.compareTo(Money.fromDecimal('5.00', USD))).toBe(0);
    });

    it('treats equal amounts as both at-least and at-most', () => {
      const same = Money.fromDecimal('5.00', USD);

      expect(five.isGreaterThanOrEqualTo(same)).toBe(true);
      expect(five.isLessThanOrEqualTo(same)).toBe(true);
    });

    it('reports sign', () => {
      expect(Money.zero(USD).isZero).toBe(true);
      expect(five.isPositive).toBe(true);
      expect(five.negated().isNegative).toBe(true);
    });
  });

  describe('equality', () => {
    it('holds for the same amount in the same currency', () => {
      expect(Money.fromDecimal('10.00', USD).equals(Money.fromMinorUnits(1000n, USD))).toBe(true);
    });

    it('fails across currencies even when the minor units match', () => {
      expect(Money.fromMinorUnits(1000n, USD).equals(Money.fromMinorUnits(1000n, EUR))).toBe(false);
    });

    it('fails against anything that is not Money', () => {
      expect(Money.zero(USD).equals(0)).toBe(false);
      expect(Money.zero(USD).equals(null)).toBe(false);
    });
  });
});
