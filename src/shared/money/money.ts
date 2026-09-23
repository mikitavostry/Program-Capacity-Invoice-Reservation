import { DomainError } from '../domain/domain-error.js';
import { ValueObject } from '../domain/value-object.js';
import { Currency } from './currency.js';
import { formatScaledDecimal, parseScaledDecimal } from './decimal.js';

/** The largest amount, in minor units, a Postgres `BIGINT` column holds. */
export const MAX_MINOR_UNITS = 2n ** 63n - 1n;

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: Currency, right: Currency) {
    super(`Cannot combine an amount in ${left.code} with one in ${right.code}.`);
  }
}

export class Money extends ValueObject {
  readonly minorUnits: bigint;
  readonly currency: Currency;

  private constructor(minorUnits: bigint, currency: Currency) {
    super();
    this.minorUnits = minorUnits;
    this.currency = currency;
  }

  static fromMinorUnits(minorUnits: bigint | number, currency: Currency): Money {
    if (typeof minorUnits === 'bigint') {
      return new Money(minorUnits, currency);
    }

    if (typeof minorUnits !== 'number' || !Number.isInteger(minorUnits)) {
      throw new InvalidAmountError(
        `An amount in minor units must be a whole number, received ${String(minorUnits)}.`,
      );
    }

    if (!Number.isSafeInteger(minorUnits)) {
      throw new InvalidAmountError(
        `${minorUnits} is too large to represent exactly as a number; pass a bigint instead.`,
      );
    }

    return new Money(BigInt(minorUnits), currency);
  }

  static fromDecimal(amount: string, currency: Currency): Money {
    const parsed = parseScaledDecimal(amount, currency.minorUnitDigits);

    if (!parsed.ok) {
      throw new InvalidAmountError(
        `"${amount}" is not a valid ${currency.code} amount: ${parsed.reason}.`,
      );
    }

    return new Money(parsed.scaled, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negated(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);

    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;

    return 0;
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  isGreaterThanOrEqualTo(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  isLessThanOrEqualTo(other: Money): boolean {
    return this.compareTo(other) <= 0;
  }

  get isZero(): boolean {
    return this.minorUnits === 0n;
  }

  get isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  get isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Money &&
      other.minorUnits === this.minorUnits &&
      other.currency.equals(this.currency)
    );
  }

  toDecimalString(): string {
    return formatScaledDecimal(this.minorUnits, this.currency.minorUnitDigits);
  }

  toJSON(): { readonly amount: string; readonly currency: string } {
    return { amount: this.toDecimalString(), currency: this.currency.code };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency.code}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
