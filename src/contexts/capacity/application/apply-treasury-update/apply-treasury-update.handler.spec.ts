import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { CapacityDiscrepancyDetected, CreditLimitChanged } from '../../domain/events.js';
import { InvoiceId, ProgramId } from '../../domain/ids.js';
import { ProgramNotFoundError } from '../errors.js';
import { OpenProgramCommand } from '../open-program/open-program.command.js';
import { ReserveCapacityCommand } from '../reserve-capacity/reserve-capacity.command.js';
import { ApplyTreasuryUpdateCommand } from './apply-treasury-update.command.js';

const USD = Currency.of('USD');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);

const PROGRAM = ProgramId.of('program-1');
const OCCURRED_AT = new Date('2026-09-20T08:00:00.000Z');

describe('ApplyTreasuryUpdateHandler', () => {
  let f: CapacityFixture;

  beforeEach(async () => {
    f = capacityFixture();
    await f.openProgram.execute(new OpenProgramCommand(PROGRAM, usd('1000.00')));
    f.events.published.length = 0;
  });

  const apply = (
    eventId: string,
    sequence: number,
    creditLimit: Money,
    reported: Money | null = null,
    programId = PROGRAM,
  ) =>
    f.applyTreasury.execute(
      new ApplyTreasuryUpdateCommand(
        programId,
        eventId,
        reported === null ? 'CAPACITY_CHANGED' : 'STATE_RECONCILED',
        sequence,
        creditLimit,
        reported,
        OCCURRED_AT,
        { eventId, sequence },
      ),
    );

  const reserve = (invoiceId: string, amount: Money) =>
    f.reserve.execute(new ReserveCapacityCommand(PROGRAM, InvoiceId.of(invoiceId), amount));

  it('applies a new credit limit and announces the change', async () => {
    const result = await apply('event-1', 1, usd('2500.00'));

    expect(result.outcome).toBe('APPLIED');
    expect(result.program?.creditLimit.equals(usd('2500.00'))).toBe(true);
    expect(f.store.program(PROGRAM).treasurySequence).toBe(1);
    expect(f.events.published[0]).toBeInstanceOf(CreditLimitChanged);
  });

  it('records the message it acted on, exactly as it arrived', async () => {
    await apply('event-1', 1, usd('2500.00'));

    expect(f.store.treasuryEvents).toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        kind: 'CAPACITY_CHANGED',
        sequence: 1,
        applied: true,
        reason: null,
        payload: { eventId: 'event-1', sequence: 1 },
      }),
    ]);
  });

  it('writes no ledger movement: a limit change moves no reserved capacity', async () => {
    await apply('event-1', 1, usd('2500.00'));

    expect(f.store.movements).toHaveLength(0);
  });

  describe('delivered more than once', () => {
    it('ignores a repeat of an event id it has already recorded', async () => {
      await apply('event-1', 1, usd('2500.00'));
      f.events.published.length = 0;

      const replay = await apply('event-1', 1, usd('2500.00'));

      expect(replay.outcome).toBe('DUPLICATE');
      expect(f.store.treasuryEvents).toHaveLength(1);
      expect(f.events.published).toHaveLength(0);
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
      f.events.published.length = 0;

      const stale = await apply('event-1', 3, usd('100.00'));

      expect(stale.outcome).toBe('STALE');
      expect(f.store.program(PROGRAM).creditLimit.equals(usd('2500.00'))).toBe(true);
      expect(f.store.treasuryEvents.at(-1)).toMatchObject({
        eventId: 'event-1',
        applied: false,
        reason: expect.stringContaining('not newer'),
      });
      expect(f.events.published).toHaveLength(0);
    });

    it('applies a later message normally', async () => {
      await apply('event-1', 3, usd('2000.00'));

      const result = await apply('event-2', 4, usd('3000.00'));

      expect(result.outcome).toBe('APPLIED');
      expect(f.store.program(PROGRAM).creditLimit.equals(usd('3000.00'))).toBe(true);
    });
  });

  describe('reconciliation', () => {
    it('reports a difference in what treasury thinks is reserved, without adopting it', async () => {
      await reserve('invoice-1', usd('250.00'));
      f.events.published.length = 0;

      await apply('event-1', 1, usd('1000.00'), usd('400.00'));

      const [event] = f.events.published as CapacityDiscrepancyDetected[];
      expect(event).toBeInstanceOf(CapacityDiscrepancyDetected);
      expect(event.difference.equals(usd('150.00'))).toBe(true);
      expect(f.store.program(PROGRAM).reservedAmount.equals(usd('250.00'))).toBe(true);
    });

    it('says nothing when the two agree', async () => {
      await reserve('invoice-1', usd('250.00'));
      f.events.published.length = 0;

      await apply('event-1', 1, usd('1000.00'), usd('250.00'));

      expect(f.events.published).toHaveLength(0);
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

  it('refuses a program it does not know, changing nothing', async () => {
    await expect(apply('event-1', 1, usd('10.00'), null, ProgramId.of('missing'))).rejects.toThrow(
      ProgramNotFoundError,
    );
    expect(f.store.treasuryEvents).toHaveLength(0);
  });
});
