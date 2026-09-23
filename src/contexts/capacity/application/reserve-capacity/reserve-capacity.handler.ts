import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { CLOCK, type Clock } from '../../../../shared/application/clock.js';
import type { ExchangeRate } from '../../../../shared/money/exchange-rate.js';
import { ReservationId } from '../../domain/ids.js';
import {
  CAPACITY_TRANSACTION_RUNNER,
  type CapacityTransactionRunner,
  type CapacityUnitOfWork,
} from '../../domain/ports/capacity-transaction-runner.js';
import {
  EXCHANGE_RATE_PROVIDER,
  type ExchangeRateProvider,
} from '../../domain/ports/exchange-rate-provider.js';
import type { Reservation } from '../../domain/reservation.js';
import {
  InvoiceAlreadyRepaidError,
  InvoiceAlreadyReservedError,
  ProgramNotFoundError,
} from '../errors.js';
import { CAPACITY_READ_MODEL, type CapacityReadModel } from '../ports/capacity-read-model.js';
import { toReservationView } from '../views.js';
import { ReserveCapacityCommand, type ReserveCapacityResult } from './reserve-capacity.command.js';

/** The rate a new reservation would need, or why it could not be had. */
type RateLookup =
  | { readonly ok: true; readonly rate: ExchangeRate | null }
  | { readonly ok: false; readonly error: unknown };

/**
 * Which requests are retries, decided under the program lock:
 *
 * - with a `reservationKey`: the reservation made under that key, active or released, is the
 *   answer; a new key is refused while the invoice still holds an active reservation;
 * - without one: the invoice's active reservation is the answer; once it has been fully repaid
 *   the request is refused (`INVOICE_ALREADY_REPAID`), since it may be a delayed retry of the
 *   original, and reserving the invoice again takes a new key.
 */
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
    const rate = await this.rateIntoProgramCurrency(command);

    const outcome = await this.transactions.run(async (uow) => {
      const program = await uow.programs.lockById(command.programId);
      if (program === null) throw new ProgramNotFoundError(command.programId);

      // Under the program lock, so two requests for one invoice cannot both miss each other.
      const existing = await findRepeated(uow, command);
      if (existing !== null) return replayOf(existing, command);

      // Only a new reservation needs the rate; a retry is answered even while rates are down.
      if (!rate.ok) throw rate.error;

      const reservation = program.reserveFor({
        reservationId: ReservationId.of(randomUUID()),
        invoiceId: command.invoiceId,
        reservationKey: command.reservationKey,
        invoiceAmount: command.invoiceAmount,
        exchangeRate: rate.rate,
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
  private async rateIntoProgramCurrency(command: ReserveCapacityCommand): Promise<RateLookup> {
    const program = await this.readModel.getProgramCapacity(command.programId);
    if (program === null) throw new ProgramNotFoundError(command.programId);

    const invoiceCurrency = command.invoiceAmount.currency;
    if (invoiceCurrency.equals(program.currency)) return { ok: true, rate: null };

    try {
      return {
        ok: true,
        rate: await this.exchangeRates.rateFor(invoiceCurrency, program.currency),
      };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

/** The reservation this request repeats, or `null` when it asks for a new one. */
async function findRepeated(
  uow: CapacityUnitOfWork,
  command: ReserveCapacityCommand,
): Promise<Reservation | null> {
  const { programId, invoiceId, reservationKey } = command;

  if (reservationKey !== null) {
    const keyed = await uow.reservations.findByKey(programId, invoiceId, reservationKey);
    if (keyed !== null) return keyed;

    if ((await uow.reservations.findActiveByInvoice(programId, invoiceId)) !== null) {
      throw InvoiceAlreadyReservedError.stillActive(invoiceId);
    }
    return null;
  }

  const active = await uow.reservations.findActiveByInvoice(programId, invoiceId);
  if (active !== null) return active;

  if (await uow.reservations.hasReleasedForInvoice(programId, invoiceId)) {
    throw new InvoiceAlreadyRepaidError(invoiceId);
  }
  return null;
}

function replayOf(
  existing: Reservation,
  command: ReserveCapacityCommand,
): { reservation: Reservation; created: false } {
  if (!existing.invoiceAmount.equals(command.invoiceAmount)) {
    throw InvoiceAlreadyReservedError.forAmount(
      command.invoiceId,
      existing.invoiceAmount,
      command.invoiceAmount,
    );
  }

  return { reservation: existing, created: false };
}
