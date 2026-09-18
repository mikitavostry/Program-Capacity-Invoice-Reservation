import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { InvoiceId, ProgramId, RepaymentId } from '../../domain/ids.js';
import { InvalidQueryError, ProgramNotFoundError } from '../errors.js';
import { GetProgramCapacityQuery } from '../get-program-capacity/get-program-capacity.query.js';
import { OpenProgramCommand } from '../open-program/open-program.command.js';
import { RecordRepaymentCommand } from '../record-repayment/record-repayment.command.js';
import { ReserveCapacityCommand } from '../reserve-capacity/reserve-capacity.command.js';
import type { ReservationView } from '../views.js';
import { ListReservationsQuery, type ListReservationsOptions } from './list-reservations.query.js';
import { decodeReservationCursor, encodeReservationCursor } from './reservation-cursor.js';

const USD = Currency.of('USD');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const PROGRAM = ProgramId.of('program-1');

describe('capacity queries', () => {
  let f: CapacityFixture;

  beforeEach(async () => {
    f = capacityFixture();
    await f.openProgram.execute(new OpenProgramCommand(PROGRAM, usd('1000.00')));
  });

  /** Five reservations, one minute apart, invoice-1 oldest. */
  async function reserveFive(): Promise<void> {
    for (let i = 1; i <= 5; i += 1) {
      await f.reserve.execute(
        new ReserveCapacityCommand(PROGRAM, InvoiceId.of(`invoice-${i}`), usd('10.00')),
      );
      f.clock.advance(60_000);
    }
  }

  const list = (options: ListReservationsOptions = {}) =>
    f.listReservations.execute(new ListReservationsQuery(PROGRAM, options));

  const invoices = (items: readonly ReservationView[]): string[] =>
    items.map((item) => item.invoiceId);

  describe('GetProgramCapacity', () => {
    it('reports the limit, what is reserved and what is available', async () => {
      await f.reserve.execute(
        new ReserveCapacityCommand(PROGRAM, InvoiceId.of('invoice-1'), usd('250.00')),
      );

      const view = await f.getCapacity.execute(new GetProgramCapacityQuery(PROGRAM));

      expect(view.creditLimit.equals(usd('1000.00'))).toBe(true);
      expect(view.reservedAmount.equals(usd('250.00'))).toBe(true);
      expect(view.availableCapacity.equals(usd('750.00'))).toBe(true);
      expect(view.currency).toBe(USD);
    });

    it('refuses a program that does not exist', async () => {
      await expect(
        f.getCapacity.execute(new GetProgramCapacityQuery(ProgramId.of('missing'))),
      ).rejects.toThrow(ProgramNotFoundError);
    });
  });

  describe('ListReservations', () => {
    it('lists newest first', async () => {
      await reserveFive();

      const page = await list();

      expect(invoices(page.items)).toEqual([
        'invoice-5',
        'invoice-4',
        'invoice-3',
        'invoice-2',
        'invoice-1',
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('pages through every reservation exactly once', async () => {
      await reserveFive();

      const first = await list({ limit: 2 });
      const second = await list({ limit: 2, cursor: first.nextCursor });
      const third = await list({ limit: 2, cursor: second.nextCursor });

      expect(invoices(first.items)).toEqual(['invoice-5', 'invoice-4']);
      expect(invoices(second.items)).toEqual(['invoice-3', 'invoice-2']);
      expect(invoices(third.items)).toEqual(['invoice-1']);
      expect(third.nextCursor).toBeNull();
    });

    it('does not offer another page when the last one is exactly full', async () => {
      await reserveFive();

      expect((await list({ limit: 5 })).nextCursor).toBeNull();
    });

    it('filters by status', async () => {
      await reserveFive();
      await f.repay.execute(
        new RecordRepaymentCommand(
          PROGRAM,
          InvoiceId.of('invoice-2'),
          RepaymentId.of('repayment-1'),
          null,
        ),
      );

      expect(invoices((await list({ status: 'RELEASED' })).items)).toEqual(['invoice-2']);
      expect((await list({ status: 'ACTIVE' })).items).toHaveLength(4);
    });

    it('returns an empty page for a program with no reservations yet', async () => {
      await expect(list()).resolves.toEqual({ items: [], nextCursor: null });
    });

    it('refuses a program that does not exist, rather than returning an empty page', async () => {
      await expect(
        f.listReservations.execute(new ListReservationsQuery(ProgramId.of('missing'))),
      ).rejects.toThrow(ProgramNotFoundError);
    });

    it.each([0, 101, 1.5, -1])('refuses a page size of %s', async (limit) => {
      await expect(list({ limit })).rejects.toThrow(InvalidQueryError);
    });

    it.each(['not-a-cursor', '', encodeURIComponent('["x","y"]')])(
      'refuses a cursor it did not issue: %j',
      async (cursor) => {
        await expect(list({ cursor })).rejects.toThrow(InvalidQueryError);
      },
    );
  });

  describe('the reservation cursor', () => {
    it('round-trips a position', () => {
      const position = {
        reservedAt: new Date('2026-09-19T09:00:00.123Z'),
        reservationId: 'reservation-1',
      };

      expect(decodeReservationCursor(encodeReservationCursor(position))).toEqual(position);
    });

    it.each([
      ['not base64 JSON', 'bm90IGpzb24'],
      ['the wrong shape', Buffer.from('{"a":1}').toString('base64url')],
      ['an invalid date', Buffer.from('["yesterday","r-1"]').toString('base64url')],
      ['an empty id', Buffer.from('["2026-09-19T09:00:00.000Z",""]').toString('base64url')],
    ])('rejects %s', (_, encoded) => {
      expect(decodeReservationCursor(encoded)).toBeNull();
    });
  });
});
