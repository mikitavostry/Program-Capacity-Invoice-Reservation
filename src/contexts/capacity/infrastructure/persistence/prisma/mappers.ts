import type {
  Prisma,
  Program as ProgramRecord,
  Reservation as ReservationRecord,
} from '../../../../../generated/prisma/client.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { ExchangeRate, RATE_DECIMAL_PLACES } from '../../../../../shared/money/exchange-rate.js';
import { Money } from '../../../../../shared/money/money.js';
import { InvoiceId, ProgramId, ReservationId } from '../../../domain/ids.js';
import { Program } from '../../../domain/program.js';
import { Reservation } from '../../../domain/reservation.js';

/*
 * Rows and aggregates are different types on purpose. Prisma's models describe table shape;
 * the aggregates describe behaviour. Every crossing goes through `rehydrate`, so a row that
 * breaks an invariant fails here, loudly, instead of becoming an aggregate that lies.
 */

export type ProgramRow = Pick<
  ProgramRecord,
  'id' | 'currency' | 'creditLimitMinor' | 'reservedMinor' | 'status' | 'version'
>;

export function toProgram(row: ProgramRow): Program {
  const currency = Currency.of(row.currency);

  return Program.rehydrate({
    id: ProgramId.of(row.id),
    creditLimit: Money.fromMinorUnits(row.creditLimitMinor, currency),
    reservedAmount: Money.fromMinorUnits(row.reservedMinor, currency),
    status: row.status,
    version: row.version,
  });
}

export function fromProgram(program: Program): Prisma.ProgramUncheckedCreateInput {
  return {
    id: program.id.value,
    currency: program.currency.code,
    creditLimitMinor: program.creditLimit.minorUnits,
    reservedMinor: program.reservedAmount.minorUnits,
    status: program.status,
    version: program.version,
  };
}

export function toReservation(row: ReservationRecord): Reservation {
  const invoiceCurrency = Currency.of(row.invoiceCurrency);
  const reservedCurrency = Currency.of(row.reservedCurrency);

  return Reservation.rehydrate({
    id: ReservationId.of(row.id),
    programId: ProgramId.of(row.programId),
    invoiceId: InvoiceId.of(row.invoiceId),
    invoiceAmount: Money.fromMinorUnits(row.invoiceMinor, invoiceCurrency),
    reservedAmount: Money.fromMinorUnits(row.reservedMinor, reservedCurrency),
    exchangeRate: toExchangeRate(row, invoiceCurrency, reservedCurrency),
    repaidAmount: Money.fromMinorUnits(row.repaidMinor, invoiceCurrency),
    releasedAmount: Money.fromMinorUnits(row.releasedMinor, reservedCurrency),
    status: row.status,
    reservedAt: row.reservedAt,
    releasedAt: row.releasedAt,
  });
}

export function fromReservation(reservation: Reservation): Prisma.ReservationUncheckedCreateInput {
  const rate = reservation.exchangeRate;

  return {
    id: reservation.id.value,
    programId: reservation.programId.value,
    invoiceId: reservation.invoiceId.value,
    invoiceCurrency: reservation.invoiceAmount.currency.code,
    invoiceMinor: reservation.invoiceAmount.minorUnits,
    reservedCurrency: reservation.reservedAmount.currency.code,
    reservedMinor: reservation.reservedAmount.minorUnits,
    // Passed as a decimal string so the rate never passes through a float on its way in.
    exchangeRate: rate === null ? null : rate.rate,
    rateAsOf: rate === null ? null : rate.asOf,
    repaidMinor: reservation.repaidAmount.minorUnits,
    releasedMinor: reservation.releasedAmount.minorUnits,
    status: reservation.status,
    reservedAt: reservation.reservedAt,
    releasedAt: reservation.releasedAt,
  };
}

function toExchangeRate(row: ReservationRecord, from: Currency, to: Currency): ExchangeRate | null {
  if (row.exchangeRate === null && row.rateAsOf === null) return null;

  if (row.exchangeRate === null || row.rateAsOf === null) {
    throw new InvariantViolationError(
      `Reservation ${row.id} has an exchange rate without its observation time, or the reverse.`,
    );
  }

  return ExchangeRate.of(from, to, row.exchangeRate.toFixed(RATE_DECIMAL_PLACES), row.rateAsOf);
}
