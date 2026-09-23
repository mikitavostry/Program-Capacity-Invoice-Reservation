import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import { InvalidAmountError } from '../../../../../shared/money/money.js';
import { CreditLimitChanged, ProgramOpened, ProgramStatusChanged } from '../../../domain/events.js';
import { ProgramNotActiveError } from '../../../domain/errors.js';
import { InvoiceId, ProgramId } from '../../../domain/ids.js';
import { ReserveCapacityCommand } from '../../reserve-capacity/reserve-capacity.command.js';
import { treasuryUpdate } from '../../../../../../test/support/treasury-commands.js';
import type { TreasuryEventKind } from '../../../domain/ports/treasury-event-log.js';
import { ProgramNotFoundError } from '../../errors.js';
import { ApplyTreasuryUpdateCommand } from '../apply-treasury-update.command.js';

const USD = Currency.of('USD');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);

const PROGRAM = ProgramId.of('program-1');
const OCCURRED_AT = new Date('2026-09-20T08:00:00.000Z');

describe('ApplyTreasuryUpdateHandler', () => {
  let f: CapacityFixture;

  beforeEach(async () => {
    f = capacityFixture();
    await f.openProgram(PROGRAM, usd('1000.00'));
    f.store.outbox.length = 0;
  });

  const apply = (
    eventId: string,
    sequence: number,
    creditLimit: Money,
    programId = PROGRAM,
    kind: TreasuryEventKind = 'CAPACITY_CHANGED',
  ) =>
    f.applyTreasury.execute(
      new ApplyTreasuryUpdateCommand(programId, eventId, kind, sequence, creditLimit, OCCURRED_AT, {
        eventId,
        sequence,
      }),
    );

  const reserve = (invoiceId: string, amount: Money) =>
    f.reserve.execute(new ReserveCapacityCommand(PROGRAM, InvoiceId.of(invoiceId), amount));

  it('applies a new credit limit and records the change in the outbox', async () => {
    const result = await apply('event-1', 1, usd('2500.00'));

    expect(result.outcome).toBe('APPLIED');
    expect(result.program?.creditLimit.equals(usd('2500.00'))).toBe(true);
    expect(f.store.program(PROGRAM).treasurySequence).toBe(1);
    expect(f.store.outbox[0]).toBeInstanceOf(CreditLimitChanged);
  });

  it('records the message it acted on, exactly as it arrived', async () => {
    await apply('event-1', 1, usd('2500.00'));

    expect(f.store.treasuryEvents.at(-1)).toEqual(
      expect.objectContaining({
        eventId: 'event-1',
        kind: 'CAPACITY_CHANGED',
        sequence: 1,
        applied: true,
        reason: null,
        payload: { eventId: 'event-1', sequence: 1 },
      }),
    );
  });

  it('writes no ledger movement: a limit change moves no reserved capacity', async () => {
    await apply('event-1', 1, usd('2500.00'));

    expect(f.store.movements).toHaveLength(0);
  });

  describe('delivered more than once', () => {
    it('ignores a repeat of an event id it has already recorded', async () => {
      await apply('event-1', 1, usd('2500.00'));
      f.store.outbox.length = 0;

      const replay = await apply('event-1', 1, usd('2500.00'));

      expect(replay.outcome).toBe('DUPLICATE');
      expect(f.store.treasuryEvents.filter((row) => row.eventId === 'event-1')).toHaveLength(1);
      expect(f.store.outbox).toHaveLength(0);
    });

    it('ignores a repeat even when it carries a different limit', async () => {
      await apply('event-1', 1, usd('2500.00'));

      await apply('event-1', 9, usd('99.00'));

      expect(f.store.program(PROGRAM).creditLimit.equals(usd('2500.00'))).toBe(true);
    });
  });

  describe('delivered out of order', () => {
    it('ignores a message older than the state already applied, but records that it arrived', async () => {
      await apply('event-2', 5, usd('2500.00'));
      f.store.outbox.length = 0;

      const stale = await apply('event-1', 3, usd('100.00'));

      expect(stale.outcome).toBe('STALE');
      expect(f.store.program(PROGRAM).creditLimit.equals(usd('2500.00'))).toBe(true);
      expect(f.store.treasuryEvents.at(-1)).toMatchObject({
        eventId: 'event-1',
        applied: false,
        reason: expect.stringContaining('not newer'),
      });
      expect(f.store.outbox).toHaveLength(0);
    });

    it('applies a later message normally', async () => {
      await apply('event-1', 3, usd('2000.00'));

      const result = await apply('event-2', 4, usd('3000.00'));

      expect(result.outcome).toBe('APPLIED');
      expect(f.store.program(PROGRAM).creditLimit.equals(usd('3000.00'))).toBe(true);
    });
  });

  describe('reconciliation', () => {
    it('applies a periodic reconciliation like any other full snapshot', async () => {
      const result = await apply('event-1', 1, usd('1500.00'), PROGRAM, 'STATE_RECONCILED');

      expect(result.outcome).toBe('APPLIED');
      expect(f.store.program(PROGRAM).creditLimit.equals(usd('1500.00'))).toBe(true);
      expect(f.store.treasuryEvents.at(-1)).toMatchObject({
        eventId: 'event-1',
        kind: 'STATE_RECONCILED',
      });
    });
  });

  describe('a limit cut below what is already reserved', () => {
    it('is applied, leaving the program over limit', async () => {
      await reserve('invoice-1', usd('800.00'));

      const result = await apply('event-1', 1, usd('500.00'));

      expect(result.outcome).toBe('APPLIED');
      expect(result.program?.availableCapacity.equals(usd('-300.00'))).toBe(true);
    });

    it('stops further reservations until repayments bring it back under', async () => {
      await reserve('invoice-1', usd('800.00'));
      await apply('event-1', 1, usd('500.00'));

      await expect(reserve('invoice-2', usd('0.01'))).rejects.toThrow(/cannot reserve/);
    });
  });

  describe('status', () => {
    const setStatus = (sequence: number, status: 'ACTIVE' | 'SUSPENDED') =>
      f.applyTreasury.execute(
        treasuryUpdate({
          programId: PROGRAM,
          creditLimit: null,
          sequence,
          status,
          kind: 'STATUS_CHANGED',
        }),
      );

    it('suspends a program and records the change in the outbox', async () => {
      const result = await setStatus(1, 'SUSPENDED');

      expect(result.outcome).toBe('APPLIED');
      expect(result.program?.status).toBe('SUSPENDED');
      expect(f.store.program(PROGRAM).status).toBe('SUSPENDED');
      expect(f.store.outbox).toEqual([expect.any(ProgramStatusChanged)]);
      await expect(reserve('invoice-1', usd('10.00'))).rejects.toThrow(ProgramNotActiveError);
    });

    it('reactivates it, after which reservations are accepted again', async () => {
      await setStatus(1, 'SUSPENDED');

      await setStatus(2, 'ACTIVE');

      await expect(reserve('invoice-1', usd('10.00'))).resolves.toMatchObject({ created: true });
    });

    it('opens a program suspended when its first message, a reconciliation, says so', async () => {
      const created = await f.applyTreasury.execute(
        treasuryUpdate({
          programId: ProgramId.of('program-new'),
          creditLimit: usd('500.00'),
          sequence: 1,
          status: 'SUSPENDED',
          kind: 'STATE_RECONCILED',
        }),
      );

      expect(created.outcome).toBe('CREATED');
      expect(created.program?.status).toBe('SUSPENDED');
      // Consumers learn it is suspended from the opening event itself.
      expect(f.store.outbox).toHaveLength(1);
      expect(f.store.outbox[0]).toBeInstanceOf(ProgramOpened);
      expect((f.store.outbox[0] as ProgramOpened).status).toBe('SUSPENDED');
    });

    it('refuses a status change for a program it does not know, opening nothing', async () => {
      const unknown = ProgramId.of('program-unknown');

      await expect(
        f.applyTreasury.execute(
          treasuryUpdate({
            programId: unknown,
            creditLimit: null,
            sequence: 1,
            status: 'SUSPENDED',
            kind: 'STATUS_CHANGED',
          }),
        ),
      ).rejects.toThrow(ProgramNotFoundError);
      expect(() => f.store.program(unknown)).toThrow();
    });
  });

  describe('the first message for a program id', () => {
    const NEW_PROGRAM = ProgramId.of('program-new');

    it('opens the program from what the message carries', async () => {
      const result = await apply('event-1', 7, usd('2500.00'), NEW_PROGRAM);

      expect(result.outcome).toBe('CREATED');
      expect(result.program).toMatchObject({ programId: 'program-new', status: 'ACTIVE' });
      expect(result.program?.creditLimit.equals(usd('2500.00'))).toBe(true);
      expect(result.program?.availableCapacity.equals(usd('2500.00'))).toBe(true);
      expect(f.store.program(NEW_PROGRAM).treasurySequence).toBe(7);
      expect(f.store.outbox).toEqual([expect.any(ProgramOpened)]);
      expect(f.store.treasuryEvents.at(-1)).toMatchObject({ eventId: 'event-1', applied: true });
    });

    it('takes the program currency from the limit', async () => {
      await apply('event-1', 1, Money.fromDecimal('500.00', Currency.of('EUR')), NEW_PROGRAM);

      expect(f.store.program(NEW_PROGRAM).currency.code).toBe('EUR');
    });

    it('treats a later message as an ordinary update', async () => {
      await apply('event-1', 1, usd('2500.00'), NEW_PROGRAM);

      const result = await apply('event-2', 2, usd('3000.00'), NEW_PROGRAM);

      expect(result.outcome).toBe('APPLIED');
      expect(f.store.program(NEW_PROGRAM).creditLimit.equals(usd('3000.00'))).toBe(true);
    });

    it('treats a redelivery of the opening message as a duplicate', async () => {
      await apply('event-1', 1, usd('2500.00'), NEW_PROGRAM);

      const replay = await apply('event-1', 1, usd('2500.00'), NEW_PROGRAM);

      expect(replay.outcome).toBe('DUPLICATE');
    });

    it('refuses a limit that is not positive, opening nothing', async () => {
      await expect(apply('event-1', 1, usd('0.00'), NEW_PROGRAM)).rejects.toThrow(
        InvalidAmountError,
      );

      expect(f.store.treasuryEvents.some((row) => row.eventId === 'event-1')).toBe(false);
      expect(() => f.store.program(NEW_PROGRAM)).toThrow();
    });
  });
});
