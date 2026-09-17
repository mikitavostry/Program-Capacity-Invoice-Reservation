import { DomainError } from '../domain/domain-error.js';
import { ValueObject } from '../domain/value-object.js';

export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(attempted: string) {
    super(`Currency "${attempted}" is not supported.`);
  }
}

/**
 * ISO 4217 codes with the number of decimal places each currency subdivides into.
 *
 * This is a curated subset rather than the full standard, and an unrecognised code is
 * rejected outright instead of being assumed to have two decimal places. That assumption is
 * how a JPY amount ends up a hundred times too small, and a financing limit is not the
 * place to find out. Extending the list is a deliberate act; guessing is not available.
 */
const MINOR_UNIT_DIGITS: ReadonlyMap<string, number> = new Map([
  // Two decimal places — the common case.
  ['USD', 2],
  ['EUR', 2],
  ['GBP', 2],
  ['CHF', 2],
  ['CAD', 2],
  ['AUD', 2],
  ['NZD', 2],
  ['SEK', 2],
  ['NOK', 2],
  ['DKK', 2],
  ['PLN', 2],
  ['CZK', 2],
  ['SGD', 2],
  ['HKD', 2],
  ['CNY', 2],
  ['INR', 2],
  ['MXN', 2],
  ['BRL', 2],
  ['ZAR', 2],
  ['TRY', 2],
  ['AED', 2],
  // No minor unit at all.
  ['JPY', 0],
  ['KRW', 0],
  ['ISK', 0],
  ['VND', 0],
  // Three decimal places.
  ['BHD', 3],
  ['KWD', 3],
  ['JOD', 3],
  ['OMR', 3],
  ['TND', 3],
]);

/**
 * An ISO 4217 currency, together with how finely it subdivides.
 *
 * Instances are interned, so `Currency.of('USD')` always returns the same object and the
 * scaling factor is computed once per currency rather than once per amount.
 */
export class Currency extends ValueObject {
  private static readonly instances = new Map<string, Currency>();

  readonly code: string;
  readonly minorUnitDigits: number;
  /** Minor units in one major unit: 100 for USD, 1 for JPY, 1000 for BHD. */
  readonly minorUnitsPerUnit: bigint;

  private constructor(code: string, minorUnitDigits: number) {
    super();
    this.code = code;
    this.minorUnitDigits = minorUnitDigits;
    this.minorUnitsPerUnit = 10n ** BigInt(minorUnitDigits);
  }

  static of(code: string): Currency {
    const normalised = typeof code === 'string' ? code.trim().toUpperCase() : '';

    const interned = Currency.instances.get(normalised);
    if (interned !== undefined) return interned;

    const digits = MINOR_UNIT_DIGITS.get(normalised);
    if (digits === undefined) {
      throw new UnsupportedCurrencyError(typeof code === 'string' ? code : String(code));
    }

    const currency = new Currency(normalised, digits);
    Currency.instances.set(normalised, currency);

    return currency;
  }

  static isSupported(code: string): boolean {
    return typeof code === 'string' && MINOR_UNIT_DIGITS.has(code.trim().toUpperCase());
  }

  equals(other: unknown): boolean {
    return other instanceof Currency && other.code === this.code;
  }

  toString(): string {
    return this.code;
  }

  toJSON(): string {
    return this.code;
  }
}
