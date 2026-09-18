import { describe, expect, it } from 'vitest';
import { Currency } from '../../../../shared/money/currency.js';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.js';
import { StaticExchangeRateProvider } from './static-exchange-rate-provider.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const GBP = Currency.of('GBP');
const AS_OF = new Date('2026-09-19T08:00:00.000Z');

describe('StaticExchangeRateProvider', () => {
  const provider = new StaticExchangeRateProvider({
    asOf: AS_OF,
    rates: { 'EUR/USD': '1.09', 'gbp/usd': '1.27' },
  });

  it('returns a listed rate, stamped with the table’s observation time', async () => {
    const rate = await provider.rateFor(EUR, USD);

    expect(rate.rate).toBe('1.09000000');
    expect(rate.asOf.toISOString()).toBe(AS_OF.toISOString());
  });

  it('accepts currency codes in any case', async () => {
    await expect(provider.rateFor(GBP, USD)).resolves.toMatchObject({ from: GBP, to: USD });
  });

  it('converts a currency into itself at an identity rate', async () => {
    expect((await provider.rateFor(USD, USD)).rate).toBe('1.00000000');
  });

  it('does not derive an inverse rate that nobody quoted', async () => {
    await expect(provider.rateFor(USD, EUR)).rejects.toThrow(ExchangeRateUnavailableError);
    await expect(provider.rateFor(USD, EUR)).rejects.toThrow(/convert USD into EUR/);
  });

  it.each([['EURUSD'], ['EUR/USD/GBP']])('refuses a malformed pair key %s', (pair) => {
    expect(() => new StaticExchangeRateProvider({ asOf: AS_OF, rates: { [pair]: '1' } })).toThrow(
      /must look like "EUR\/USD"/,
    );
  });

  it('refuses an invalid rate or an unknown currency when the table is loaded, not when used', () => {
    expect(
      () => new StaticExchangeRateProvider({ asOf: AS_OF, rates: { 'EUR/USD': '-1' } }),
    ).toThrow(/greater than zero/);
    expect(
      () => new StaticExchangeRateProvider({ asOf: AS_OF, rates: { 'EUR/XYZ': '1' } }),
    ).toThrow(/not supported/);
  });
});
