import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { Currency } from '../../../../shared/money/currency.js';
import type { ExchangeRate } from '../../../../shared/money/exchange-rate.js';

export interface ExchangeRateProvider {
  /**
   * The current `from` → `to` rate. May be a network call, so never call it inside a
   * transaction. Rejects with `ExchangeRateUnavailableError` for an unknown pair.
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
