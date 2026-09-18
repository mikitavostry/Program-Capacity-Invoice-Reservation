import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { InsufficientCapacityError } from '../../domain/errors.js';
import { CapacityReserved } from '../../domain/events.js';
import { InvoiceId, ProgramId, RepaymentId } from '../../domain/ids.js';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.js';
import { InvoiceAlreadyReservedError, ProgramNotFoundError } from '../errors.js';
import { OpenProgramCommand } from '../open-program/open-program.command.js';
import { RecordRepaymentCommand } from '../record-repayment/record-repayment.command.js';
import { ReserveCapacityCommand } from './reserve-capacity.command.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const JPY = Currency.of('JPY');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);

const PROGRAM = ProgramId.of('program-1');
const INVOICE = InvoiceId.of('invoice-1');

describe('ReserveCapacityHandler', () => {
  let f: CapacityFixture;

  beforeEach(async () => {
    f = capacityFixture();
    await f.openProgram.execute(new OpenProgramCommand(PROGRAM, usd('1000.00')));
    f.events.published.length = 0;
  });

  const reserve = (amount: Money, invoice = INVOICE) =>
    f.reserve.execute(new ReserveCapacityCommand(PROGRAM, invoice, amount));

  it('reserves capacity for an invoice in the program’s currency', async () => {
    const { reservation, created } = await reserve(usd('250.00'));

    expect(created).toBe(true);
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.invoiceId).toBe('invoice-1');
    expect(reservation.reservedAmount.equals(usd('250.00'))).toBe(true);
    expect(reservation.reservedAt.toISOString()).toBe('2026-09-19T09:00:00.000Z');
    expect(f.store.program(PROGRAM).availableCapacity.equals(usd('750.00'))).toBe(true);
  });

  it('records the reservation in the ledger and announces it once committed', async () => {
    await reserve(usd('250.00'));

    expect(f.store.movements).toHaveLength(1);
    expect(f.events.published).toHaveLength(1);
    expect(f.events.published[0]).toBeInstanceOf(CapacityReserved);
  });

  it('converts an invoice in another currency at the provider’s rate', async () => {
    const { reservation } = await reserve(eur('100.00'));

    expect(reservation.invoiceAmount.equals(eur('100.00'))).toBe(true);
    expect(reservation.reservedAmount.equals(usd('109.00'))).toBe(true);
    expect(reservation.exchangeRate?.rate).toBe('1.09000000');
  });

  it('fetches the rate before opening the transaction, never while the program is locked', async () => {
    await reserve(eur('100.00'));

    expect(f.rates.lookups).toEqual([{ from: 'EUR', to: 'USD', duringTransaction: false }]);
  });

  it('does not look up a rate when the currencies already match', async () => {
    await reserve(usd('100.00'));

    expect(f.rates.lookups).toHaveLength(0);
  });

  it('refuses a currency it has no rate for, before any transaction opens', async () => {
    const commitsBefore = f.store.commits;

    await expect(reserve(Money.fromDecimal('1000', JPY))).rejects.toThrow(
      ExchangeRateUnavailableError,
    );
    expect(f.store.commits).toBe(commitsBefore);
  });

  describe('a repeated request', () => {
    it('is answered with the existing reservation, holding nothing more', async () => {
      const first = await reserve(usd('250.00'));
      const second = await reserve(usd('250.00'));

      expect(second.created).toBe(false);
      expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
      expect(f.store.program(PROGRAM).reservedAmount.equals(usd('250.00'))).toBe(true);
      expect(f.store.movements).toHaveLength(1);
      expect(f.events.published).toHaveLength(1);
    });

    it('for a different amount is refused rather than guessed at', async () => {
      await reserve(usd('250.00'));

      await expect(reserve(usd('300.00'))).rejects.toThrow(InvoiceAlreadyReservedError);
      expect(f.store.program(PROGRAM).reservedAmount.equals(usd('250.00'))).toBe(true);
    });

    it('creates a new reservation once the first one has been fully repaid', async () => {
      const first = await reserve(usd('250.00'));
      await f.repay.execute(
        new RecordRepaymentCommand(PROGRAM, INVOICE, RepaymentId.of('repayment-1'), null),
      );

      const second = await reserve(usd('250.00'));

      expect(second.created).toBe(true);
      expect(second.reservation.reservationId).not.toBe(first.reservation.reservationId);
    });
  });

  describe('refusals', () => {
    it('refuses what does not fit, writing and announcing nothing', async () => {
      await reserve(usd('900.00'), InvoiceId.of('invoice-0'));
      const commitsBefore = f.store.commits;
      f.events.published.length = 0;

      await expect(reserve(usd('100.01'))).rejects.toThrow(InsufficientCapacityError);

      expect(f.store.commits).toBe(commitsBefore);
      expect(f.store.program(PROGRAM).reservedAmount.equals(usd('900.00'))).toBe(true);
      expect(f.store.movements).toHaveLength(1);
      expect(f.events.published).toHaveLength(0);
    });

    it('refuses a program that does not exist, without looking up a rate', async () => {
      await expect(
        f.reserve.execute(
          new ReserveCapacityCommand(ProgramId.of('missing'), INVOICE, eur('10.00')),
        ),
      ).rejects.toThrow(ProgramNotFoundError);
      expect(f.rates.lookups).toHaveLength(0);
    });
  });
});
