import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  capacityTotals,
  createTestPrisma,
  truncateAll,
} from '../../../../../test/infrastructure/database.js';
import { FixedClock } from '../../../../../test/support/in-memory-capacity.js';
import { openingMessage, treasuryUpdate } from '../../../../../test/support/treasury-commands.js';
import type { PrismaClient } from '../../../../platform/prisma/prisma-client.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { InvoiceId, ProgramId, RepaymentId } from '../../domain/ids.js';
import { StaticExchangeRateProvider } from '../../infrastructure/fx/static-exchange-rate-provider.js';
import { PrismaCapacityReadModel } from '../../infrastructure/persistence/prisma/prisma-capacity-read-model.js';
import {
  DEFAULT_TRANSACTION_SETTINGS,
  PrismaCapacityTransactionRunner,
} from '../../infrastructure/persistence/prisma/prisma-capacity-transaction-runner.js';
import { GetProgramCapacityHandler } from '../get-program-capacity/get-program-capacity.handler.js';
import { GetProgramCapacityQuery } from '../get-program-capacity/get-program-capacity.query.js';
import { ListReservationsHandler } from '../list-reservations/list-reservations.handler.js';
import { ListReservationsQuery } from '../list-reservations/list-reservations.query.js';
import { ApplyTreasuryUpdateHandler } from '../apply-treasury-update/apply-treasury-update.handler.js';
import { RecordRepaymentCommand } from '../record-repayment/record-repayment.command.js';
import { RecordRepaymentHandler } from '../record-repayment/record-repayment.handler.js';
import { ReserveCapacityCommand } from '../reserve-capacity/reserve-capacity.command.js';
import { ReserveCapacityHandler } from '../reserve-capacity/reserve-capacity.handler.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);

const PROGRAM = ProgramId.of('program-1');

describe('capacity handlers against Postgres', () => {
  let prisma: PrismaClient;
  let clock: FixedClock;
  let handlers: ReturnType<typeof wire>;

  function wire() {
    const transactions = new PrismaCapacityTransactionRunner(prisma, {
      ...DEFAULT_TRANSACTION_SETTINGS,
      lockTimeoutMs: 20_000,
      transactionTimeoutMs: 30_000,
      maxWaitMs: 20_000,
    });
    const readModel = new PrismaCapacityReadModel(prisma);
    const rates = new StaticExchangeRateProvider({
      asOf: new Date('2026-09-19T08:00:00.000Z'),
      rates: { 'EUR/USD': '1.09' },
    });

    return {
      treasury: new ApplyTreasuryUpdateHandler(transactions),
      reserve: new ReserveCapacityHandler(transactions, readModel, rates, clock),
      repay: new RecordRepaymentHandler(transactions, clock),
      capacity: new GetProgramCapacityHandler(readModel),
      list: new ListReservationsHandler(readModel),
    };
  }

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    clock = new FixedClock(new Date('2026-09-19T09:00:00.000Z'));
    handlers = wire();
    await handlers.treasury.execute(openingMessage(PROGRAM, usd('1000.00')));
  });

  const reserve = (invoice: string, amount: Money) =>
    handlers.reserve.execute(new ReserveCapacityCommand(PROGRAM, InvoiceId.of(invoice), amount));

  const repay = (invoice: string, repaymentId: string, amount: Money | null) =>
    handlers.repay.execute(
      new RecordRepaymentCommand(
        PROGRAM,
        InvoiceId.of(invoice),
        RepaymentId.of(repaymentId),
        amount,
      ),
    );

  it('takes an invoice in another currency from reservation through two repayments', async () => {
    const reserved = await reserve('invoice-1', eur('100.00'));
    const partial = await repay('invoice-1', 'repayment-1', eur('40.00'));
    const final = await repay('invoice-1', 'repayment-2', null);

    expect(reserved.reservation.reservedAmount.equals(usd('109.00'))).toBe(true);
    expect(partial.releasedAmount.equals(usd('43.60'))).toBe(true);
    expect(final.releasedAmount.equals(usd('65.40'))).toBe(true);
    expect(final.reservation.status).toBe('RELEASED');

    const capacity = await handlers.capacity.execute(new GetProgramCapacityQuery(PROGRAM));
    expect(capacity.availableCapacity.equals(usd('1000.00'))).toBe(true);
    await expect(capacityTotals(prisma, PROGRAM.value)).resolves.toEqual({
      counter: 0n,
      held: 0n,
      ledger: 0n,
    });
  });

  it('opens a program once when two first messages for it race', async () => {
    const racing = ProgramId.of('program-racing');

    const results = await Promise.all([
      handlers.treasury.execute(
        treasuryUpdate({ programId: racing, creditLimit: usd('500.00'), sequence: 1 }),
      ),
      handlers.treasury.execute(
        treasuryUpdate({ programId: racing, creditLimit: usd('700.00'), sequence: 2 }),
      ),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(
      expect.arrayContaining(['CREATED']),
    );
    expect(results.filter((result) => result.outcome === 'CREATED')).toHaveLength(1);
    await expect(prisma.program.count({ where: { id: racing.value } })).resolves.toBe(1);
    await expect(prisma.treasuryEvent.count({ where: { programId: racing.value } })).resolves.toBe(
      2,
    );
  });

  it('pages through reservations from the database', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await reserve(`invoice-${i}`, usd('10.00'));
      clock.advance(60_000);
    }

    const first = await handlers.list.execute(new ListReservationsQuery(PROGRAM, { limit: 3 }));
    const second = await handlers.list.execute(
      new ListReservationsQuery(PROGRAM, { limit: 3, cursor: first.nextCursor }),
    );

    expect(first.items.map((r) => r.invoiceId)).toEqual(['invoice-5', 'invoice-4', 'invoice-3']);
    expect(second.items.map((r) => r.invoiceId)).toEqual(['invoice-2', 'invoice-1']);
    expect(second.nextCursor).toBeNull();
  });

  describe('idempotency under concurrent delivery', () => {
    it('holds capacity once when the same reservation arrives several times at once', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => reserve('invoice-1', usd('100.00'))),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.reservation.reservationId)).size).toBe(1);
      await expect(capacityTotals(prisma, PROGRAM.value)).resolves.toEqual({
        counter: 10000n,
        held: 10000n,
        ledger: 10000n,
      });
    });

    it('applies a repayment once when the same one arrives several times at once', async () => {
      await reserve('invoice-1', usd('100.00'));

      const results = await Promise.all(
        Array.from({ length: 5 }, () => repay('invoice-1', 'repayment-1', usd('40.00'))),
      );

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.every((r) => r.releasedAmount.equals(usd('40.00')))).toBe(true);
      await expect(capacityTotals(prisma, PROGRAM.value)).resolves.toEqual({
        counter: 6000n,
        held: 6000n,
        ledger: 6000n,
      });
    });
  });
});
