import { describe, expect, it } from 'vitest';
import { Currency } from '../currency.js';
import {
  ExchangeRate,
  InvalidExchangeRateError,
  RateNotApplicableError,
} from '../exchange-rate.js';
import { Money } from '../money.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const GBP = Currency.of('GBP');
const JPY = Currency.of('JPY');
const BHD = Currency.of('BHD');

const AS_OF = new Date('2026-09-17T10:00:00.000Z');

describe('ExchangeRate', () => {
  describe('construction', () => {
    it('rejects a rate that is not positive', () => {
      expect(() => ExchangeRate.of(EUR, USD, '0', AS_OF)).toThrow(InvalidExchangeRateError);
      expect(() => ExchangeRate.of(EUR, USD, '-1.09', AS_OF)).toThrow(/greater than zero/);
    });

    it('rejects precision beyond eight decimal places instead of silently dropping it', () => {
      expect(() => ExchangeRate.of(EUR, USD, '1.123456789', AS_OF)).toThrow(
        /at most 8 decimal places/,
      );
    });

    it.each(['', 'abc', '1,09'])('rejects %s as a rate', (input) => {
      expect(() => ExchangeRate.of(EUR, USD, input, AS_OF)).toThrow(InvalidExchangeRateError);
    });

    it('requires a valid observation time', () => {
      expect(() => ExchangeRate.of(EUR, USD, '1.09', new Date('nonsense'))).toThrow(
        /valid observation time/,
      );
    });

    it('keeps the rate at full scale', () => {
      expect(ExchangeRate.of(EUR, USD, '1.09', AS_OF).rate).toBe('1.09000000');
    });
  });

  describe('conversion', () => {
    it('converts between two currencies with the same subdivision', () => {
      const rate = ExchangeRate.of(EUR, USD, '1.09', AS_OF);
      const converted = rate.convert(Money.fromDecimal('100.00', EUR));

      expect(converted.toDecimalString()).toBe('109.00');
      expect(converted.currency).toBe(USD);
    });

    it('converts into a currency with no minor unit', () => {
      const rate = ExchangeRate.of(USD, JPY, '150.00', AS_OF);

      expect(rate.convert(Money.fromDecimal('10.00', USD)).toDecimalString()).toBe('1500');
    });

    it('converts out of a currency with no minor unit', () => {
      const rate = ExchangeRate.of(JPY, USD, '0.00665', AS_OF);

      expect(rate.convert(Money.fromDecimal('1000', JPY)).toDecimalString()).toBe('6.65');
    });

    it('converts into a currency with three decimal places', () => {
      const rate = ExchangeRate.of(USD, BHD, '0.376', AS_OF);

      expect(rate.convert(Money.fromDecimal('100.00', USD)).toDecimalString()).toBe('37.600');
    });

    it('converts nothing through an identity rate', () => {
      const rate = ExchangeRate.identity(USD, AS_OF);
      const amount = Money.fromDecimal('1234.56', USD);

      expect(rate.convert(amount).equals(amount)).toBe(true);
    });

    it('refuses an amount the rate does not apply to', () => {
      const rate = ExchangeRate.of(EUR, USD, '1.09', AS_OF);

      expect(() => rate.convert(Money.fromDecimal('10.00', GBP))).toThrow(RateNotApplicableError);
      expect(() => rate.convert(Money.fromDecimal('10.00', GBP))).toThrow(
        /EUR\/USD rate cannot convert an amount in GBP/,
      );
    });
  });

  describe('rounding', () => {
    it('rounds a reservation up by default, so rounding can never breach a limit', () => {
      // 0.01 EUR at 1.095 is 0.01095 USD exactly.
      const rate = ExchangeRate.of(EUR, USD, '1.095', AS_OF);

      expect(rate.convert(Money.fromDecimal('0.01', EUR)).toDecimalString()).toBe('0.02');
    });

    it('rounds down when asked to, as a partial release does', () => {
      const rate = ExchangeRate.of(EUR, USD, '1.095', AS_OF);

      expect(rate.convert(Money.fromDecimal('0.01', EUR), 'FLOOR').toDecimalString()).toBe('0.01');
    });

    it('applies the same split into a currency with no minor unit', () => {
      // 10.00 USD at 150.24 is 1502.4 JPY exactly.
      const rate = ExchangeRate.of(USD, JPY, '150.24', AS_OF);
      const amount = Money.fromDecimal('10.00', USD);

      expect(rate.convert(amount).toDecimalString()).toBe('1503');
      expect(rate.convert(amount, 'FLOOR').toDecimalString()).toBe('1502');
    });

    it('leaves an exact conversion alone under either policy', () => {
      const rate = ExchangeRate.of(EUR, USD, '2', AS_OF);
      const amount = Money.fromDecimal('1.00', EUR);

      expect(rate.convert(amount).toDecimalString()).toBe('2.00');
      expect(rate.convert(amount, 'FLOOR').toDecimalString()).toBe('2.00');
    });
  });

  describe('the observation time', () => {
    it('cannot be changed through the Date it was built from', () => {
      const mutable = new Date(AS_OF);
      const rate = ExchangeRate.of(EUR, USD, '1.09', mutable);

      mutable.setFullYear(1999);

      expect(rate.asOf.toISOString()).toBe(AS_OF.toISOString());
    });

    it('cannot be changed through the Date it hands back', () => {
      const rate = ExchangeRate.of(EUR, USD, '1.09', AS_OF);

      rate.asOf.setFullYear(1999);

      expect(rate.asOf.toISOString()).toBe(AS_OF.toISOString());
    });
  });

  describe('equality and serialisation', () => {
    it('compares currencies, rate and observation time', () => {
      const rate = ExchangeRate.of(EUR, USD, '1.09', AS_OF);

      expect(rate.equals(ExchangeRate.of(EUR, USD, '1.09000000', AS_OF))).toBe(true);
      expect(rate.equals(ExchangeRate.of(EUR, USD, '1.10', AS_OF))).toBe(false);
      expect(rate.equals(ExchangeRate.of(USD, EUR, '1.09', AS_OF))).toBe(false);
      expect(rate.equals(ExchangeRate.of(EUR, USD, '1.09', new Date('2026-09-18')))).toBe(false);
      expect(rate.equals('1.09')).toBe(false);
    });

    it('serialises everything needed to explain a conversion after the fact', () => {
      expect(ExchangeRate.of(EUR, USD, '1.09', AS_OF).toJSON()).toEqual({
        from: 'EUR',
        to: 'USD',
        rate: '1.09000000',
        asOf: '2026-09-17T10:00:00.000Z',
      });
    });
  });
});
