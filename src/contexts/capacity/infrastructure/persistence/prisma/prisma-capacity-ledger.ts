import type { Prisma } from '../../../../../generated/prisma/client.js';
import type { DomainEvent } from '../../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import {
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
  ProgramStatusChanged,
} from '../../../domain/events.js';
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

/** The ledger rows for one event. An unknown event throws, so no movement goes unrecorded. */
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

  // No reserved capacity moves; `treasury_events` audits these.
  if (
    event instanceof ProgramOpened ||
    event instanceof CreditLimitChanged ||
    event instanceof ProgramStatusChanged
  ) {
    return [];
  }

  throw new InvariantViolationError(
    `The capacity ledger does not know how to record a ${event.eventName} event.`,
  );
}
