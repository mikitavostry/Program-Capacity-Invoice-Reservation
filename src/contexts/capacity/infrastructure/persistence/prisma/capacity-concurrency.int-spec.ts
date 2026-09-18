import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  capacityTotals,
  createTestPrisma,
  truncateAll,
} from '../../../../../../test/integration/database.js';
import type { PrismaClient } from '../../../../../platform/prisma/prisma-client.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import { InsufficientCapacityError } from '../../../domain/errors.js';
import { InvoiceId, ProgramId, RepaymentId, ReservationId } from '../../../domain/ids.js';
import { CapacityBusyError } from '../../../domain/ports/capacity-transaction-runner.js';
import { Program } from '../../../domain/program.js';
import type { Reservation } from '../../../domain/reservation.js';
import {
  DEFAULT_TRANSACTION_SETTINGS,
  PrismaCapacityTransactionRunner,
} from './prisma-capacity-transaction-runner.js';

/*
 * These tests are the reason the locking decision in docs/architecture.md §6 can be trusted.
 * They run against real Postgres because what they exercise is the concurrency control
 * itself, which no in-memory fake can reproduce.
 */

const USD = Currency.of('USD');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('capacity under concurrency', () => {
  let prisma: PrismaClient;
  let runner: PrismaCapacityTransactionRunner;

  beforeAll(() => {
    prisma = createTestPrisma();
    runner = new PrismaCapacityTransactionRunner(prisma, {
      ...DEFAULT_TRANSACTION_SETTINGS,
      // Generous: a burst queues on one program lock, and none of those waiters should give up.
      lockTimeoutMs: 20_000,
      transactionTimeoutMs: 30_000,
      maxWaitMs: 20_000,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function openProgram(limit: Money): Promise<ProgramId> {
    const program = Program.open({
      id: ProgramId.of(`program-${randomUUID()}`),
      creditLimit: limit,
      openedAt: new Date(),
    });
    await runner.run((uow) => uow.programs.insert(program));
    return program.id;
  }

  function reserve(programId: ProgramId, amount: Money): Promise<Reservation> {
    return runner.run(async (uow) => {
      const program = await uow.programs.lockById(programId);
      if (program === null) throw new Error(`No program ${programId.value}`);

      const reservation = program.reserveFor({
        reservationId: ReservationId.of(randomUUID()),
        invoiceId: InvoiceId.of(`invoice-${randomUUID()}`),
        invoiceAmount: amount,
        exchangeRate: null,
        at: new Date(),
      });

      await uow.programs.save(program);
      await uow.reservations.insert(reservation);
      await uow.ledger.record(program.pullDomainEvents());
      return reservation;
    });
  }

  function repay(reservation: Reservation, amount: Money): Promise<Money> {
    return runner.run(async (uow) => {
      const program = await uow.programs.lockById(reservation.programId);
      const current = await uow.reservations.findById(reservation.id);
      if (program === null || current === null) throw new Error('Missing program or reservation');

      const released = program.release(current, {
        repaymentId: RepaymentId.of(randomUUID()),
        amount,
        at: new Date(),
      });

      await uow.programs.save(program);
      await uow.reservations.save(current);
      await uow.ledger.record(program.pullDomainEvents());
      return released;
    });
  }

  it('never oversubscribes a program, and turns away only what genuinely does not fit', async () => {
    // Room for exactly 20 of these; 30 arrive at once.
    const programId = await openProgram(usd('1000.00'));

    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () => reserve(programId, usd('50.00'))),
    );

    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );

    // Exactly the right number succeed: no reservation that fits is refused for bad timing,
    // and none that does not fit slips through.
    expect(accepted).toHaveLength(20);
    expect(rejected).toHaveLength(10);
    for (const { reason } of rejected) {
      expect(reason).toBeInstanceOf(InsufficientCapacityError);
    }

    await expect(capacityTotals(prisma, programId.value)).resolves.toEqual({
      counter: 100000n,
      held: 100000n,
      ledger: 100000n,
    });
  });

  it('applies concurrent partial repayments to one reservation exactly once each', async () => {
    const programId = await openProgram(usd('1000.00'));
    const reservation = await reserve(programId, usd('100.00'));

    const released = await Promise.all(
      Array.from({ length: 10 }, () => repay(reservation, usd('10.00'))),
    );

    expect(released.every((amount) => amount.equals(usd('10.00')))).toBe(true);

    const stored = await runner.run((uow) => uow.reservations.findById(reservation.id));
    expect(stored?.isReleased).toBe(true);
    await expect(capacityTotals(prisma, programId.value)).resolves.toEqual({
      counter: 0n,
      held: 0n,
      ledger: 0n,
    });
  });

  describe('when a program is held by a slow transaction', () => {
    const impatientSettings = { ...DEFAULT_TRANSACTION_SETTINGS, lockTimeoutMs: 200 };

    async function holdLock(programId: ProgramId): Promise<{ release(): Promise<void> }> {
      const locked = gate();
      const finish = gate();
      const holding = runner.run(async (uow) => {
        await uow.programs.lockById(programId);
        locked.open();
        await finish.opened;
      });
      await locked.opened;

      return {
        async release() {
          finish.open();
          await holding;
        },
      };
    }

    it('gives up waiting with a retryable CapacityBusyError, having written nothing', async () => {
      const programId = await openProgram(usd('1000.00'));
      const impatient = new PrismaCapacityTransactionRunner(prisma, impatientSettings);
      const holder = await holdLock(programId);

      try {
        const started = Date.now();
        await expect(
          impatient.run(async (uow) => {
            const program = await uow.programs.lockById(programId);
            program!.reserveFor({
              reservationId: ReservationId.of(randomUUID()),
              invoiceId: InvoiceId.of('invoice-1'),
              invoiceAmount: usd('10.00'),
              exchangeRate: null,
              at: new Date(),
            });
            await uow.programs.save(program!);
          }),
        ).rejects.toBeInstanceOf(CapacityBusyError);
        // It gave up at the lock timeout rather than queueing behind the holder indefinitely.
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await holder.release();
      }

      await expect(capacityTotals(prisma, programId.value)).resolves.toMatchObject({
        counter: 0n,
      });
    });

    it('does not hold up writers to a different program', async () => {
      const busy = await openProgram(usd('1000.00'));
      const other = await openProgram(usd('1000.00'));
      const impatient = new PrismaCapacityTransactionRunner(prisma, impatientSettings);
      const holder = await holdLock(busy);

      try {
        await expect(impatient.run((uow) => uow.programs.lockById(other))).resolves.not.toBeNull();
      } finally {
        await holder.release();
      }
    });
  });
});
