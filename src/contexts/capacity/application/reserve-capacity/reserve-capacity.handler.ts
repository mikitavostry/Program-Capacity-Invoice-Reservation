import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { CLOCK, type Clock } from '../../../../shared/application/clock.js';
import type { ExchangeRate } from '../../../../shared/money/exchange-rate.js';
import { ReservationId } from '../../domain/ids.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
} from '../../domain/ports/capacity-transaction-runner.js';
import {
  EXCHANGE_RATE_PROVIDER,
  type ExchangeRateProvider,
} from '../../domain/ports/exchange-rate-provider.js';
import type { Reservation } from '../../domain/reservation.js';
import { InvoiceAlreadyReservedError, ProgramNotFoundError } from '../errors.js';
import { CAPACITY_READ_MODEL, type CapacityReadModel } from '../ports/capacity-read-model.js';
import { toReservationView } from '../views.js';
import { ReserveCapacityCommand, type ReserveCapacityResult } from './reserve-capacity.command.js';

@CommandHandler(ReserveCapacityCommand)
export class ReserveCapacityHandler implements ICommandHandler<ReserveCapacityCommand> {
  constructor(
    @Inject(CAPACITY_TRANSACTION_RUNNER) private readonly transactions: CapacityTransactionRunner,
    @Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel,
    @Inject(EXCHANGE_RATE_PROVIDER) private readonly exchangeRates: ExchangeRateProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ReserveCapacityCommand): Promise<ReserveCapacityResult> {
    // Before the transaction, which holds the program's row lock.
    const exchangeRate = await this.rateIntoProgramCurrency(command);

    const outcome = await this.transactions.run(async (uow) => {
      const program = await uow.programs.lockById(command.programId);
      if (program === null) throw new ProgramNotFoundError(command.programId);

      // Under the program lock, so two requests for one invoice cannot both miss it.
      const existing = await uow.reservations.findActiveByInvoice(
        command.programId,
        command.invoiceId,
      );
      if (existing !== null) return replayOf(existing, command);

      const reservation = program.reserveFor({
        reservationId: ReservationId.of(randomUUID()),
        invoiceId: command.invoiceId,
        invoiceAmount: command.invoiceAmount,
        exchangeRate,
        at: this.clock.now(),
      });

      await uow.programs.save(program);
      await uow.reservations.insert(reservation);
      const events = program.pullDomainEvents();
      await uow.ledger.record(events);
      await uow.outbox.add(events);

      return { reservation, created: true };
    });

    return { reservation: toReservationView(outcome.reservation), created: outcome.created };
  }

  /** Read without a lock: a program's currency never changes. */
  private async rateIntoProgramCurrency(
    command: ReserveCapacityCommand,
  ): Promise<ExchangeRate | null> {
    const program = await this.readModel.getProgramCapacity(command.programId);
    if (program === null) throw new ProgramNotFoundError(command.programId);

    const invoiceCurrency = command.invoiceAmount.currency;
    if (invoiceCurrency.equals(program.currency)) return null;

    return this.exchangeRates.rateFor(invoiceCurrency, program.currency);
  }
}

function replayOf(
  existing: Reservation,
  command: ReserveCapacityCommand,
): { reservation: Reservation; created: false } {
  if (!existing.invoiceAmount.equals(command.invoiceAmount)) {
    throw new InvoiceAlreadyReservedError(
      command.invoiceId,
      existing.invoiceAmount,
      command.invoiceAmount,
    );
  }

  return { reservation: existing, created: false };
}
