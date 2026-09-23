import type { Currency } from '../../../shared/money/currency.js';
import type { ExchangeRate } from '../../../shared/money/exchange-rate.js';
import type { Money } from '../../../shared/money/money.js';
import type { Program, ProgramStatus } from '../domain/program.js';
import type { Reservation, ReservationStatus } from '../domain/reservation.js';

export interface ProgramCapacityView {
  readonly programId: string;
  readonly currency: Currency;
  readonly creditLimit: Money;
  readonly reservedAmount: Money;
  readonly availableCapacity: Money;
  readonly status: ProgramStatus;
}

export interface ReservationView {
  readonly reservationId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly reservationKey: string | null;
  readonly status: ReservationStatus;
  readonly invoiceAmount: Money;
  readonly reservedAmount: Money;
  readonly exchangeRate: ExchangeRate | null;
  readonly repaidAmount: Money;
  readonly releasedAmount: Money;
  readonly outstandingAmount: Money;
  readonly heldAmount: Money;
  readonly reservedAt: Date;
  readonly releasedAt: Date | null;
}

export interface ReservationPage {
  readonly items: readonly ReservationView[];
  readonly nextCursor: string | null;
}

export function toProgramCapacityView(program: Program): ProgramCapacityView {
  return {
    programId: program.id.value,
    currency: program.currency,
    creditLimit: program.creditLimit,
    reservedAmount: program.reservedAmount,
    availableCapacity: program.availableCapacity,
    status: program.status,
  };
}

export function toReservationView(reservation: Reservation): ReservationView {
  return {
    reservationId: reservation.id.value,
    programId: reservation.programId.value,
    invoiceId: reservation.invoiceId.value,
    reservationKey: reservation.reservationKey?.value ?? null,
    status: reservation.status,
    invoiceAmount: reservation.invoiceAmount,
    reservedAmount: reservation.reservedAmount,
    exchangeRate: reservation.exchangeRate,
    repaidAmount: reservation.repaidAmount,
    releasedAmount: reservation.releasedAmount,
    outstandingAmount: reservation.outstandingAmount,
    heldAmount: reservation.heldAmount,
    reservedAt: reservation.reservedAt,
    releasedAt: reservation.releasedAt,
  };
}
