import { DomainError } from '../domain/domain-error.js';
import { ValueObject } from '../domain/value-object.js';

export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(attempted: string) {
    super(`Currency "${attempted}" is not supported.`);
  }
}

/**
 * ISO 4217 codes and their minor-unit digits. A curated subset: an unknown code is refused
 * rather than assumed to have two decimals, which would make a JPY amount 100 times too small.
 */
const MINOR_UNIT_DIGITS: ReadonlyMap<string, number> = new Map([
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
  ['JPY', 0],
  ['KRW', 0],
  ['ISK', 0],
  ['VND', 0],
  ['BHD', 3],
  ['KWD', 3],
  ['JOD', 3],
  ['OMR', 3],
  ['TND', 3],
]);

export class Currency extends ValueObject {
  private static readonly instances = new Map<string, Currency>();

  readonly code: string;
  readonly minorUnitDigits: number;
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
