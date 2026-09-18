import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  capacityTotals,
  createTestPrisma,
  truncateAll,
} from '../../../../../../test/integration/database.js';
import type { PrismaClient } from '../../../../../platform/prisma/prisma-client.js';
import type { DomainEvent } from '../../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { ExchangeRate } from '../../../../../shared/money/exchange-rate.js';
import { Money } from '../../../../../shared/money/money.js';
import { InvoiceId, ProgramId, RepaymentId, ReservationId } from '../../../domain/ids.js';
import { Program } from '../../../domain/program.js';
import type { Reservation } from '../../../domain/reservation.js';
import { PrismaCapacityTransactionRunner } from './prisma-capacity-transaction-runner.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);

const RESERVED_AT = new Date('2026-09-18T10:00:00.000Z');
const REPAID_AT = new Date('2026-09-18T11:00:00.000Z');

describe('Prisma persistence', () => {
  let prisma: PrismaClient;
  let runner: PrismaCapacityTransactionRunner;

  beforeAll(() => {
    prisma = createTestPrisma();
    runner = new PrismaCapacityTransactionRunner(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function openProgram(limit = usd('1000.00')): Promise<ProgramId> {
    const program = Program.open({
      id: ProgramId.of(`program-${randomUUID()}`),
      creditLimit: limit,
      openedAt: RESERVED_AT,
    });
    await runner.run(async (uow) => {
      await uow.programs.insert(program);
      await uow.ledger.record(program.pullDomainEvents());
    });
    return program.id;
  }

  /** Reserves the way the command handler will: lock, decide, write all three, commit. */
  async function reserve(
    programId: ProgramId,
    amount: Money,
    exchangeRate: ExchangeRate | null = null,
    invoiceId = InvoiceId.of(`invoice-${randomUUID()}`),
  ): Promise<Reservation> {
    return runner.run(async (uow) => {
      const program = await uow.programs.lockById(programId);
      if (program === null) throw new Error(`No program ${programId.value}`);

      const reservation = program.reserveFor({
        reservationId: ReservationId.of(randomUUID()),
        invoiceId,
        invoiceAmount: amount,
        exchangeRate,
        at: RESERVED_AT,
      });

      await uow.programs.save(program);
      await uow.reservations.insert(reservation);
      await uow.ledger.record(program.pullDomainEvents());
      return reservation;
    });
  }

  async function repay(
    reservation: Reservation,
    amount: Money | null,
    repaymentId = RepaymentId.of(`repayment-${randomUUID()}`),
  ): Promise<void> {
    await runner.run(async (uow) => {
      const program = await uow.programs.lockById(reservation.programId);
      const current = await uow.reservations.findById(reservation.id);
      if (program === null || current === null) throw new Error('Missing program or reservation');

      program.release(current, { repaymentId, amount, at: REPAID_AT });

      await uow.programs.save(program);
      await uow.reservations.save(current);
      await uow.ledger.record(program.pullDomainEvents());
    });
  }

  describe('programs', () => {
    it('round-trips through insert and lock', async () => {
      const id = await openProgram(usd('10000000.00'));

      const loaded = await runner.run((uow) => uow.programs.lockById(id));

      expect(loaded?.creditLimit.equals(usd('10000000.00'))).toBe(true);
      expect(loaded?.reservedAmount.isZero).toBe(true);
      expect(loaded?.status).toBe('ACTIVE');
      expect(loaded?.version).toBe(0);
    });

    it('returns nothing for a program that does not exist', async () => {
      await expect(
        runner.run((uow) => uow.programs.lockById(ProgramId.of('missing'))),
      ).resolves.toBeNull();
    });

    it('moves the version on every save', async () => {
      const id = await openProgram();
      await reserve(id, usd('10.00'));
      await reserve(id, usd('10.00'));

      const loaded = await runner.run((uow) => uow.programs.lockById(id));

      expect(loaded?.version).toBe(2);
    });

    it('refuses to save a program whose stored version has moved on', async () => {
      const id = await openProgram();
      const stale = await runner.run((uow) => uow.programs.lockById(id));
      await reserve(id, usd('10.00'));

      await expect(runner.run((uow) => uow.programs.save(stale!))).rejects.toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('reservations', () => {
    it('round-trips a converted reservation, rate snapshot included', async () => {
      const id = await openProgram();
      const rate = ExchangeRate.of(EUR, USD, '1.09', RESERVED_AT);
      const reserved = await reserve(id, eur('100.00'), rate);

      const loaded = await runner.run((uow) => uow.reservations.findById(reserved.id));

      expect(loaded?.toSnapshot()).toEqual(reserved.toSnapshot());
      expect(loaded?.exchangeRate?.rate).toBe('1.09000000');
    });

    it('keeps a rate with all eight decimal places intact', async () => {
      const id = await openProgram();
      const rate = ExchangeRate.of(EUR, USD, '1.08765432', RESERVED_AT);
      const reserved = await reserve(id, eur('100.00'), rate);

      const loaded = await runner.run((uow) => uow.reservations.findById(reserved.id));

      expect(loaded?.exchangeRate?.equals(rate)).toBe(true);
    });

    it('finds the active reservation for an invoice, and none once it is fully repaid', async () => {
      const id = await openProgram();
      const invoiceId = InvoiceId.of('invoice-1');
      const reserved = await reserve(id, usd('100.00'), null, invoiceId);

      const active = await runner.run((uow) => uow.reservations.findActiveByInvoice(id, invoiceId));
      expect(active?.id.equals(reserved.id)).toBe(true);

      await repay(reserved, null);

      await expect(
        runner.run((uow) => uow.reservations.findActiveByInvoice(id, invoiceId)),
      ).resolves.toBeNull();
    });

    it('persists a partial repayment', async () => {
      const id = await openProgram();
      const reserved = await reserve(id, usd('100.00'));

      await repay(reserved, usd('30.00'));
      const loaded = await runner.run((uow) => uow.reservations.findById(reserved.id));

      expect(loaded?.isActive).toBe(true);
      expect(loaded?.repaidAmount.equals(usd('30.00'))).toBe(true);
      expect(loaded?.heldAmount.equals(usd('70.00'))).toBe(true);
    });
  });

  describe('the ledger', () => {
    it('keeps the counter, the reservations and the ledger in agreement', async () => {
      const id = await openProgram();
      const first = await reserve(id, usd('100.00'));
      await reserve(id, usd('250.00'));
      await repay(first, usd('40.00'));

      await expect(capacityTotals(prisma, id.value)).resolves.toEqual({
        counter: 31000n,
        held: 31000n,
        ledger: 31000n,
      });
    });

    it('records one movement per change, with availability after each', async () => {
      const id = await openProgram();
      const reserved = await reserve(id, usd('100.00'));
      await repay(reserved, usd('40.00'), RepaymentId.of('repayment-1'));

      const movements = await prisma.capacityMovement.findMany({
        where: { programId: id.value },
        orderBy: { occurredAt: 'asc' },
      });

      expect(
        movements.map((m) => [m.type, m.amountMinor, m.availableAfterMinor, m.repaymentId]),
      ).toEqual([
        ['RESERVE', 10000n, 90000n, null],
        ['RELEASE', 4000n, 94000n, 'repayment-1'],
      ]);
    });

    it('finds an applied repayment by its id, with what it repaid and freed', async () => {
      const id = await openProgram();
      const rate = ExchangeRate.of(EUR, USD, '1.09', RESERVED_AT);
      const reserved = await reserve(id, eur('100.00'), rate);
      await repay(reserved, eur('40.00'), RepaymentId.of('repayment-1'));

      const recorded = await runner.run((uow) =>
        uow.ledger.findRepayment(id, RepaymentId.of('repayment-1')),
      );

      expect(recorded?.reservationId.equals(reserved.id)).toBe(true);
      expect(recorded?.repaidAmount.equals(eur('40.00'))).toBe(true);
      expect(recorded?.releasedAmount.equals(usd('43.60'))).toBe(true);
    });

    it('returns nothing for a repayment it has not seen', async () => {
      const id = await openProgram();

      await expect(
        runner.run((uow) => uow.ledger.findRepayment(id, RepaymentId.of('unknown'))),
      ).resolves.toBeNull();
    });

    it('refuses an event it does not know how to record, rather than skipping it', async () => {
      const unknown: DomainEvent = {
        eventName: 'CreditLimitChanged',
        aggregateId: 'program-1',
        occurredAt: RESERVED_AT,
      };

      await expect(runner.run((uow) => uow.ledger.record([unknown]))).rejects.toThrow(
        /does not know how to record a CreditLimitChanged event/,
      );
    });

    it('cannot be rewritten or deleted', async () => {
      const id = await openProgram();
      await reserve(id, usd('100.00'));

      await expect(
        prisma.$executeRaw`UPDATE capacity_movements SET amount_minor = 1 WHERE program_id = ${id.value}`,
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRaw`DELETE FROM capacity_movements WHERE program_id = ${id.value}`,
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('database constraints, as a last line of defence', () => {
    it('refuses to reserve beyond the credit limit even when the domain is bypassed', async () => {
      const id = await openProgram(usd('1000.00'));

      await expect(
        prisma.$executeRaw`UPDATE programs SET reserved_minor = 100001 WHERE id = ${id.value}`,
      ).rejects.toThrow(/programs_reserved_within_limit/);
    });

    it('refuses a second active reservation for the same invoice', async () => {
      const id = await openProgram();
      const invoiceId = InvoiceId.of('invoice-1');
      await reserve(id, usd('10.00'), null, invoiceId);

      await expect(reserve(id, usd('10.00'), null, invoiceId)).rejects.toThrow(
        /Unique constraint|reservations_one_active_per_invoice/,
      );
    });

    it('allows the invoice to be reserved again once the first reservation is fully repaid', async () => {
      const id = await openProgram();
      const invoiceId = InvoiceId.of('invoice-1');
      const first = await reserve(id, usd('10.00'), null, invoiceId);
      await repay(first, null);

      await expect(reserve(id, usd('10.00'), null, invoiceId)).resolves.toBeDefined();
    });

    it('refuses a reservation held in a currency other than its program’s', async () => {
      const id = await openProgram();

      await expect(
        prisma.$executeRaw`
          INSERT INTO reservations (id, program_id, invoice_id, invoice_currency, invoice_minor,
                                    reserved_currency, reserved_minor, repaid_minor, released_minor,
                                    status, reserved_at)
          VALUES ('r-1', ${id.value}, 'i-1', 'EUR', 100, 'EUR', 100, 0, 0, 'ACTIVE', now())`,
      ).rejects.toThrow(/reservations_program_id_reserved_currency_fkey/);
    });

    it('refuses to apply the same repayment id twice', async () => {
      const id = await openProgram();
      const reserved = await reserve(id, usd('100.00'));
      await repay(reserved, usd('10.00'), RepaymentId.of('repayment-1'));

      await expect(repay(reserved, usd('10.00'), RepaymentId.of('repayment-1'))).rejects.toThrow(
        /Unique constraint|capacity_movements_program_id_repayment_id_key/,
      );
      await expect(capacityTotals(prisma, id.value)).resolves.toMatchObject({ counter: 9000n });
    });
  });
});
