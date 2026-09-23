import { beforeEach, describe, expect, it } from 'vitest';
import {
  capacityFixture,
  type CapacityFixture,
} from '../../../../../../test/support/capacity-fixture.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import { RepaymentExceedsOutstandingError } from '../../../domain/errors.js';
import { CapacityReleased } from '../../../domain/events.js';
import { InvoiceId, ProgramId, RepaymentId } from '../../../domain/ids.js';
import {
  ProgramNotFoundError,
  RepaymentIdReusedError,
  ReservationNotFoundError,
} from '../../errors.js';
import { ReserveCapacityCommand } from '../../reserve-capacity/reserve-capacity.command.js';
import { RecordRepaymentCommand } from '../record-repayment.command.js';

const USD = Currency.of('USD');
const EUR = Currency.of('EUR');
const usd = (amount: string): Money => Money.fromDecimal(amount, USD);
const eur = (amount: string): Money => Money.fromDecimal(amount, EUR);

const PROGRAM = ProgramId.of('program-1');
const INVOICE = InvoiceId.of('invoice-1');

describe('RecordRepaymentHandler', () => {
  let f: CapacityFixture;

  beforeEach(async () => {
    f = capacityFixture();
    await f.openProgram(PROGRAM, usd('1000.00'));
  });

  async function reserve(amount: Money, invoice = INVOICE): Promise<void> {
    await f.reserve.execute(new ReserveCapacityCommand(PROGRAM, invoice, amount));
    f.store.outbox.length = 0;
  }

  const repay = (repaymentId: string, amount: Money | null, invoice = INVOICE) =>
    f.repay.execute(
      new RecordRepaymentCommand(PROGRAM, invoice, RepaymentId.of(repaymentId), amount),
    );

  const reserved = (): Money => f.store.program(PROGRAM).reservedAmount;

  it('frees the repaid share and keeps holding the rest', async () => {
    await reserve(usd('100.00'));

    const result = await repay('repayment-1', usd('40.00'));

    expect(result.replayed).toBe(false);
    expect(result.repaidAmount.equals(usd('40.00'))).toBe(true);
    expect(result.releasedAmount.equals(usd('40.00'))).toBe(true);
    expect(result.reservation.status).toBe('ACTIVE');
    expect(result.reservation.outstandingAmount.equals(usd('60.00'))).toBe(true);
    expect(reserved().equals(usd('60.00'))).toBe(true);
  });

  it('repays whatever is outstanding when no amount is given', async () => {
    await reserve(usd('100.00'));
    await repay('repayment-1', usd('40.00'));

    const result = await repay('repayment-2', null);

    expect(result.repaidAmount.equals(usd('60.00'))).toBe(true);
    expect(result.reservation.status).toBe('RELEASED');
    expect(reserved().isZero).toBe(true);
  });

  it('frees capacity for a converted invoice at the rate it was reserved at', async () => {
    await reserve(eur('100.00'));

    const result = await repay('repayment-1', eur('40.00'));

    expect(result.releasedAmount.equals(usd('43.60'))).toBe(true);
  });

  it('records the repayment in the ledger and the outbox', async () => {
    await reserve(usd('100.00'));

    await repay('repayment-1', usd('40.00'));

    const [event] = f.store.outbox as CapacityReleased[];
    expect(f.store.outbox).toHaveLength(1);
    expect(event).toBeInstanceOf(CapacityReleased);
    expect(event.repaymentId.value).toBe('repayment-1');
  });

  describe('a repayment id seen before', () => {
    it('is answered with its original outcome and applied only once', async () => {
      await reserve(usd('100.00'));
      await repay('repayment-1', usd('40.00'));
      f.store.outbox.length = 0;
      const movementsBefore = f.store.movements.length;

      const replay = await repay('repayment-1', usd('40.00'));

      expect(replay.replayed).toBe(true);
      expect(replay.releasedAmount.equals(usd('40.00'))).toBe(true);
      expect(reserved().equals(usd('60.00'))).toBe(true);
      expect(f.store.movements).toHaveLength(movementsBefore);
      expect(f.store.outbox).toHaveLength(0);
    });

    it('matches a repeated "repay the rest" to whatever the rest turned out to be', async () => {
      await reserve(usd('100.00'));
      await repay('repayment-1', null);

      const replay = await repay('repayment-1', null);

      expect(replay.replayed).toBe(true);
      expect(replay.repaidAmount.equals(usd('100.00'))).toBe(true);
    });

    it('is refused when sent again with a different amount', async () => {
      await reserve(usd('100.00'));
      await repay('repayment-1', usd('40.00'));

      await expect(repay('repayment-1', usd('50.00'))).rejects.toThrow(RepaymentIdReusedError);
      expect(reserved().equals(usd('60.00'))).toBe(true);
    });

    it('is refused when sent again for a different invoice', async () => {
      await reserve(usd('100.00'));
      await reserve(usd('100.00'), InvoiceId.of('invoice-2'));
      await repay('repayment-1', usd('40.00'));

      await expect(repay('repayment-1', usd('40.00'), InvoiceId.of('invoice-2'))).rejects.toThrow(
        RepaymentIdReusedError,
      );
    });
  });

  describe('refusals', () => {
    it('refuses an invoice that was never reserved', async () => {
      await expect(repay('repayment-1', usd('10.00'))).rejects.toThrow(ReservationNotFoundError);
    });

    it('refuses a new repayment once the invoice is fully repaid', async () => {
      await reserve(usd('100.00'));
      await repay('repayment-1', null);

      await expect(repay('repayment-2', usd('1.00'))).rejects.toThrow(ReservationNotFoundError);
    });

    it('refuses an overpayment and rolls back completely', async () => {
      await reserve(usd('100.00'));
      const movementsBefore = f.store.movements.length;

      await expect(repay('repayment-1', usd('100.01'))).rejects.toThrow(
        RepaymentExceedsOutstandingError,
      );

      expect(reserved().equals(usd('100.00'))).toBe(true);
      expect(f.store.movements).toHaveLength(movementsBefore);
      expect(f.store.outbox).toHaveLength(0);
    });

    it('refuses a program that does not exist', async () => {
      await expect(
        f.repay.execute(
          new RecordRepaymentCommand(
            ProgramId.of('missing'),
            INVOICE,
            RepaymentId.of('repayment-1'),
            null,
          ),
        ),
      ).rejects.toThrow(ProgramNotFoundError);
    });
  });
});
