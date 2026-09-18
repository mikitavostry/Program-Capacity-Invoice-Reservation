import { Inject } from '@nestjs/common';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { CLOCK, type Clock } from '../../../../shared/application/clock.js';
import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation-error.js';
import type { Money } from '../../../../shared/money/money.js';
import type { RecordedRepayment } from '../../domain/ports/capacity-ledger.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
  type CapacityUnitOfWork,
} from '../../domain/ports/capacity-transaction-runner.js';
import type { Reservation } from '../../domain/reservation.js';
import {
  ProgramNotFoundError,
  RepaymentIdReusedError,
  ReservationNotFoundError,
} from '../errors.js';
import { toReservationView } from '../views.js';
import { RecordRepaymentCommand, type RecordRepaymentResult } from './record-repayment.command.js';

interface Outcome {
  readonly reservation: Reservation;
  readonly repaidAmount: Money;
  readonly releasedAmount: Money;
  readonly replayed: boolean;
  readonly events: DomainEvent[];
}

@CommandHandler(RecordRepaymentCommand)
export class RecordRepaymentHandler implements ICommandHandler<RecordRepaymentCommand> {
  constructor(
    @Inject(CAPACITY_TRANSACTION_RUNNER) private readonly transactions: CapacityTransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  async execute(command: RecordRepaymentCommand): Promise<RecordRepaymentResult> {
    const outcome = await this.transactions.run(async (uow): Promise<Outcome> => {
      const program = await uow.programs.lockById(command.programId);
      if (program === null) throw new ProgramNotFoundError(command.programId);

      // Checked under the program lock, so two deliveries of one repayment cannot both miss it.
      const recorded = await uow.ledger.findRepayment(command.programId, command.repaymentId);
      if (recorded !== null) return replayOf(recorded, command, uow);

      const reservation = await uow.reservations.findActiveByInvoice(
        command.programId,
        command.invoiceId,
      );
      if (reservation === null) {
        throw new ReservationNotFoundError(command.programId, command.invoiceId);
      }

      const repaidAmount = command.amount ?? reservation.outstandingAmount;
      const releasedAmount = program.release(reservation, {
        repaymentId: command.repaymentId,
        amount: repaidAmount,
        at: this.clock.now(),
      });

      await uow.programs.save(program);
      await uow.reservations.save(reservation);
      const events = program.pullDomainEvents();
      await uow.ledger.record(events);

      return { reservation, repaidAmount, releasedAmount, replayed: false, events };
    });

    this.events.publishAll(outcome.events);

    return {
      repaymentId: command.repaymentId.value,
      repaidAmount: outcome.repaidAmount,
      releasedAmount: outcome.releasedAmount,
      reservation: toReservationView(outcome.reservation),
      replayed: outcome.replayed,
    };
  }
}

/**
 * Answers a repayment id that has already been applied with what it did the first time.
 *
 * It must be the same repayment: same invoice, and the same amount — or no amount, which
 * means "whatever was outstanding" and matches whatever that turned out to be.
 */
async function replayOf(
  recorded: RecordedRepayment,
  command: RecordRepaymentCommand,
  uow: CapacityUnitOfWork,
): Promise<Outcome> {
  const reservation = await uow.reservations.findById(recorded.reservationId);
  if (reservation === null) {
    throw new InvariantViolationError(
      `Repayment ${command.repaymentId.value} is in the ledger against reservation ${recorded.reservationId.value}, which does not exist.`,
    );
  }

  const sameInvoice = reservation.invoiceId.equals(command.invoiceId);
  const sameAmount = command.amount === null || command.amount.equals(recorded.repaidAmount);
  if (!sameInvoice || !sameAmount) throw new RepaymentIdReusedError(command.repaymentId);

  return {
    reservation,
    repaidAmount: recorded.repaidAmount,
    releasedAmount: recorded.releasedAmount,
    replayed: true,
    events: [],
  };
}
