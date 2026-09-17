import { describe, expect, it } from 'vitest';
import { Currency, UnsupportedCurrencyError } from './currency.js';

describe('Currency', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(Currency.of('  usd ').code).toBe('USD');
  });

  it('interns instances, so the same code yields the same object', () => {
    expect(Currency.of('usd')).toBe(Currency.of('USD'));
  });

  it('rejects a code it does not recognise rather than assuming two decimal places', () => {
    expect(() => Currency.of('XYZ')).toThrow(UnsupportedCurrencyError);
    expect(() => Currency.of('XYZ')).toThrow(/"XYZ" is not supported/);
  });

  it('rejects a value that is not a string', () => {
    expect(() => Currency.of(undefined as unknown as string)).toThrow(UnsupportedCurrencyError);
  });

  describe('minor units', () => {
    it.each([
      ['USD', 2, 100n],
      ['EUR', 2, 100n],
      ['JPY', 0, 1n],
      ['KRW', 0, 1n],
      ['BHD', 3, 1000n],
      ['KWD', 3, 1000n],
    ])('describes %s as %i decimal places', (code, digits, perUnit) => {
      const currency = Currency.of(code);

      expect(currency.minorUnitDigits).toBe(digits);
      expect(currency.minorUnitsPerUnit).toBe(perUnit);
    });
  });

  it('reports which codes are supported without throwing', () => {
    expect(Currency.isSupported('jpy')).toBe(true);
    expect(Currency.isSupported('XYZ')).toBe(false);
    expect(Currency.isSupported(null as unknown as string)).toBe(false);
  });

  it('compares by code', () => {
    expect(Currency.of('USD').equals(Currency.of('USD'))).toBe(true);
    expect(Currency.of('USD').equals(Currency.of('EUR'))).toBe(false);
    expect(Currency.of('USD').equals('USD')).toBe(false);
  });

  it('serialises to its code', () => {
    expect(JSON.stringify({ currency: Currency.of('EUR') })).toBe('{"currency":"EUR"}');
    expect(String(Currency.of('EUR'))).toBe('EUR');
  });
});
