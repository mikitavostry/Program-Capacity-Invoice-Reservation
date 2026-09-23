import { DomainError } from '../domain/domain-error.js';
import { ValueObject } from '../domain/value-object.js';
import { Currency } from './currency.js';
import { formatScaledDecimal, parseScaledDecimal } from './decimal.js';
import { Money } from './money.js';
import { divideWithRounding, type RoundingMode } from './rounding.js';

/** Rates are held to eight decimal places, the precision market data is normally quoted to. */
export const RATE_DECIMAL_PLACES = 8;

const RATE_SCALE = 10n ** BigInt(RATE_DECIMAL_PLACES);

export class InvalidExchangeRateError extends DomainError {
  readonly code = 'INVALID_EXCHANGE_RATE';

  constructor(message: string) {
    super(message);
  }
}

export class RateNotApplicableError extends DomainError {
  readonly code = 'CURRENCY_NOT_CONVERTIBLE';

  constructor(from: Currency, to: Currency, amountCurrency: Currency) {
    super(`A ${from.code}/${to.code} rate cannot convert an amount in ${amountCurrency.code}.`);
  }
}

/**
 * A rate between two currencies and when it was observed. A reservation stores the rate it
 * used, so its releases convert at the same rate and the conversion can be audited later.
 */
export class ExchangeRate extends ValueObject {
  readonly from: Currency;
  readonly to: Currency;
  /** The rate multiplied by `10 ** RATE_DECIMAL_PLACES`, so it stays an exact integer. */
  readonly scaledRate: bigint;

  #asOfMillis: number;

  private constructor(from: Currency, to: Currency, scaledRate: bigint, asOfMillis: number) {
    super();
    this.from = from;
    this.to = to;
    this.scaledRate = scaledRate;
    this.#asOfMillis = asOfMillis;
  }

  static of(from: Currency, to: Currency, rate: string, asOf: Date): ExchangeRate {
    const parsed = parseScaledDecimal(rate, RATE_DECIMAL_PLACES);

    if (!parsed.ok) {
      throw new InvalidExchangeRateError(
        `"${rate}" is not a valid ${from.code}/${to.code} rate: ${parsed.reason}.`,
      );
    }

    if (parsed.scaled <= 0n) {
      throw new InvalidExchangeRateError(
        `A ${from.code}/${to.code} rate must be greater than zero.`,
      );
    }

    if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
      throw new InvalidExchangeRateError(
        `A ${from.code}/${to.code} rate must carry a valid observation time.`,
      );
    }

    return new ExchangeRate(from, to, parsed.scaled, asOf.getTime());
  }

  static identity(currency: Currency, asOf: Date): ExchangeRate {
    return ExchangeRate.of(currency, currency, '1', asOf);
  }

  get asOf(): Date {
    return new Date(this.#asOfMillis);
  }

  get rate(): string {
    return formatScaledDecimal(this.scaledRate, RATE_DECIMAL_PLACES);
  }

  /** Converts into `to` with a single integer division, so it rounds exactly once. */
  convert(amount: Money, mode: RoundingMode = 'CEILING'): Money {
    if (!amount.currency.equals(this.from)) {
      throw new RateNotApplicableError(this.from, this.to, amount.currency);
    }

    const numerator = amount.minorUnits * this.scaledRate * this.to.minorUnitsPerUnit;
    const divisor = RATE_SCALE * this.from.minorUnitsPerUnit;

    return Money.fromMinorUnits(divideWithRounding(numerator, divisor, mode), this.to);
  }

  equals(other: unknown): boolean {
    return (
      other instanceof ExchangeRate &&
      other.from.equals(this.from) &&
      other.to.equals(this.to) &&
      other.scaledRate === this.scaledRate &&
      other.asOf.getTime() === this.#asOfMillis
    );
  }

  toJSON(): {
    readonly from: string;
    readonly to: string;
    readonly rate: string;
    readonly asOf: string;
  } {
    return {
      from: this.from.code,
      to: this.to.code,
      rate: this.rate,
      asOf: this.asOf.toISOString(),
    };
  }

  toString(): string {
    return `${this.from.code}/${this.to.code} @ ${this.rate}`;
  }
}
