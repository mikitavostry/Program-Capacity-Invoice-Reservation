import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { Currency } from '../../../../shared/money/currency.js';
import type { ExchangeRate } from '../../../../shared/money/exchange-rate.js';

export interface ExchangeRateProvider {
  /**
   * The rate for converting `from` into `to` now.
   *
   * Always called before a transaction opens, never inside one: it may be a network call,
   * and a program's row is locked for the whole transaction.
   *
   * Rejects with `ExchangeRateUnavailableError` when no rate is known for the pair.
   */
  rateFor(from: Currency, to: Currency): Promise<ExchangeRate>;
}

export const EXCHANGE_RATE_PROVIDER = Symbol('ExchangeRateProvider');

export class ExchangeRateUnavailableError extends DomainError {
  readonly code = 'CURRENCY_NOT_CONVERTIBLE';

  constructor(from: Currency, to: Currency) {
    super(`No exchange rate is available to convert ${from.code} into ${to.code}.`);
  }
}
