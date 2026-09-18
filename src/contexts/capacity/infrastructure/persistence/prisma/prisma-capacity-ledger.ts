import type { Prisma } from '../../../../../generated/prisma/client.js';
import type { DomainEvent } from '../../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import { CapacityReleased, CapacityReserved, ProgramOpened } from '../../../domain/events.js';
import { ReservationId, type ProgramId, type RepaymentId } from '../../../domain/ids.js';
import type { CapacityLedger, RecordedRepayment } from '../../../domain/ports/capacity-ledger.js';

type MovementInput = Prisma.CapacityMovementCreateManyInput;

export class PrismaCapacityLedger implements CapacityLedger {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async record(events: readonly DomainEvent[]): Promise<void> {
    const movements = events.flatMap((event) => toMovements(event));
    if (movements.length === 0) return;

    await this.tx.capacityMovement.createMany({ data: movements });
  }

  async findRepayment(
    programId: ProgramId,
    repaymentId: RepaymentId,
  ): Promise<RecordedRepayment | null> {
    const row = await this.tx.capacityMovement.findUnique({
      where: {
        programId_repaymentId: { programId: programId.value, repaymentId: repaymentId.value },
      },
    });

    if (row === null) return null;

    if (row.repaidCurrency === null || row.repaidMinor === null) {
      throw new InvariantViolationError(
        `Ledger movement ${row.id} records repayment ${repaymentId.value} without its amount.`,
      );
    }

    return {
      reservationId: ReservationId.of(row.reservationId),
      repaidAmount: Money.fromMinorUnits(row.repaidMinor, Currency.of(row.repaidCurrency)),
      releasedAmount: Money.fromMinorUnits(row.amountMinor, Currency.of(row.currency)),
      occurredAt: row.occurredAt,
    };
  }
}

/**
 * Translates one domain event into the ledger rows it implies.
 *
 * An event the ledger does not recognise is an error, not something to skip. A new kind of
 * capacity change that silently left no trace would break the ledger's one promise — that
 * it explains every movement of the counter — and the drift check would only notice later.
 */
function toMovements(event: DomainEvent): MovementInput[] {
  if (event instanceof CapacityReserved) {
    return [
      {
        programId: event.aggregateId,
        reservationId: event.reservationId.value,
        type: 'RESERVE',
        currency: event.reservedAmount.currency.code,
        amountMinor: event.reservedAmount.minorUnits,
        availableAfterMinor: event.availableAfter.minorUnits,
        occurredAt: event.occurredAt,
      },
    ];
  }

  if (event instanceof CapacityReleased) {
    return [
      {
        programId: event.aggregateId,
        reservationId: event.reservationId.value,
        type: 'RELEASE',
        currency: event.releasedAmount.currency.code,
        amountMinor: event.releasedAmount.minorUnits,
        availableAfterMinor: event.availableAfter.minorUnits,
        repaymentId: event.repaymentId.value,
        repaidCurrency: event.repaidAmount.currency.code,
        repaidMinor: event.repaidAmount.minorUnits,
        occurredAt: event.occurredAt,
      },
    ];
  }

  // Opening a program sets its limit; it moves no reserved capacity.
  if (event instanceof ProgramOpened) return [];

  throw new InvariantViolationError(
    `The capacity ledger does not know how to record a ${event.eventName} event.`,
  );
}
