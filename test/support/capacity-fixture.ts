import { GetProgramCapacityHandler } from '../../src/contexts/capacity/application/get-program-capacity/get-program-capacity.handler.js';
import { ListReservationsHandler } from '../../src/contexts/capacity/application/list-reservations/list-reservations.handler.js';
import { OpenProgramHandler } from '../../src/contexts/capacity/application/open-program/open-program.handler.js';
import { RecordRepaymentHandler } from '../../src/contexts/capacity/application/record-repayment/record-repayment.handler.js';
import { ReserveCapacityHandler } from '../../src/contexts/capacity/application/reserve-capacity/reserve-capacity.handler.js';
import type { ExchangeRateProvider } from '../../src/contexts/capacity/domain/ports/exchange-rate-provider.js';
import { StaticExchangeRateProvider } from '../../src/contexts/capacity/infrastructure/fx/static-exchange-rate-provider.js';
import type { Currency } from '../../src/shared/money/currency.js';
import type { ExchangeRate } from '../../src/shared/money/exchange-rate.js';
import { FixedClock, InMemoryCapacity, RecordingEventBus } from './in-memory-capacity.js';

export const FIXTURE_START = new Date('2026-09-19T09:00:00.000Z');
export const RATES_AS_OF = new Date('2026-09-19T08:00:00.000Z');

/** Records each rate lookup, and whether a transaction was open when it happened. */
export class ObservedRates implements ExchangeRateProvider {
  readonly lookups: { from: string; to: string; duringTransaction: boolean }[] = [];

  constructor(
    private readonly inner: ExchangeRateProvider,
    private readonly store: InMemoryCapacity,
  ) {}

  async rateFor(from: Currency, to: Currency): Promise<ExchangeRate> {
    this.lookups.push({
      from: from.code,
      to: to.code,
      duringTransaction: this.store.openTransactions > 0,
    });
    return this.inner.rateFor(from, to);
  }
}

/** Real handlers over in-memory ports. */
export function capacityFixture() {
  const store = new InMemoryCapacity();
  const events = new RecordingEventBus();
  const clock = new FixedClock(FIXTURE_START);
  const rates = new ObservedRates(
    new StaticExchangeRateProvider({
      asOf: RATES_AS_OF,
      rates: { 'EUR/USD': '1.09', 'EUR/GBP': '0.85' },
    }),
    store,
  );
  const bus = events.asEventBus();

  return {
    store,
    events,
    clock,
    rates,
    openProgram: new OpenProgramHandler(store.transactions, store.readModel, clock, bus),
    reserve: new ReserveCapacityHandler(store.transactions, store.readModel, rates, clock, bus),
    repay: new RecordRepaymentHandler(store.transactions, clock, bus),
    getCapacity: new GetProgramCapacityHandler(store.readModel),
    listReservations: new ListReservationsHandler(store.readModel),
  };
}

export type CapacityFixture = ReturnType<typeof capacityFixture>;
