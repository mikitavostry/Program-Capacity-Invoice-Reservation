import { Currency } from '../../../../shared/money/currency.js';
import { ExchangeRate } from '../../../../shared/money/exchange-rate.js';
import {
  ExchangeRateUnavailableError,
  type ExchangeRateProvider,
} from '../../domain/ports/exchange-rate-provider.js';

export interface StaticRateTable {
  /** When these rates were observed; recorded on every reservation that uses one. */
  readonly asOf: Date;
  /** Keyed `"FROM/TO"`, e.g. `{ "EUR/USD": "1.09" }`, each rate a decimal string. */
  readonly rates: Readonly<Record<string, string>>;
}

/**
 * Rates from a fixed table — a stand-in for a real market-data or treasury rate service,
 * which would implement the same port.
 *
 * Only pairs that are listed are available. The inverse of a listed rate is deliberately not
 * derived: inverting at eight decimal places is itself a rounding, producing a rate nobody
 * quoted, and a reservation would then record a rate no one could trace back to a source.
 */
export class StaticExchangeRateProvider implements ExchangeRateProvider {
  readonly #asOf: Date;
  readonly #rates: ReadonlyMap<string, ExchangeRate>;

  constructor(table: StaticRateTable) {
    this.#asOf = new Date(table.asOf);
    this.#rates = new Map(
      Object.entries(table.rates).map(([pair, rate]) => {
        const [from, to, ...rest] = pair.split('/');
        if (from === undefined || to === undefined || rest.length > 0) {
          throw new Error(`Exchange rate key "${pair}" must look like "EUR/USD".`);
        }

        const parsed = ExchangeRate.of(Currency.of(from), Currency.of(to), rate, this.#asOf);
        return [key(parsed.from, parsed.to), parsed] as const;
      }),
    );
  }

  async rateFor(from: Currency, to: Currency): Promise<ExchangeRate> {
    if (from.equals(to)) return ExchangeRate.identity(from, this.#asOf);

    const rate = this.#rates.get(key(from, to));
    if (rate === undefined) throw new ExchangeRateUnavailableError(from, to);

    return rate;
  }
}

function key(from: Currency, to: Currency): string {
  return `${from.code}/${to.code}`;
}
