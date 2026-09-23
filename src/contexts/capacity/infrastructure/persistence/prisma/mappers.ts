import type {
  Prisma,
  Program as ProgramRecord,
  Reservation as ReservationRecord,
} from '../../../../../generated/prisma/client.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { ExchangeRate, RATE_DECIMAL_PLACES } from '../../../../../shared/money/exchange-rate.js';
import { Money } from '../../../../../shared/money/money.js';
import { InvoiceId, ProgramId, ReservationId, ReservationKey } from '../../../domain/ids.js';
import { Program } from '../../../domain/program.js';
import { Reservation } from '../../../domain/reservation.js';

/* Rows become aggregates only through `rehydrate`, so a corrupt row fails loudly here. */

export type ProgramRow = Pick<
  ProgramRecord,
  | 'id'
  | 'currency'
  | 'creditLimitMinor'
  | 'reservedMinor'
  | 'status'
  | 'version'
  | 'treasurySequence'
>;

export function toProgram(row: ProgramRow): Program {
  const currency = Currency.of(row.currency);

  return Program.rehydrate({
    id: ProgramId.of(row.id),
    creditLimit: Money.fromMinorUnits(row.creditLimitMinor, currency),
    reservedAmount: Money.fromMinorUnits(row.reservedMinor, currency),
    status: row.status,
    version: row.version,
    treasurySequence: toSequence(row.id, row.treasurySequence),
  });
}

/** BIGINT in the database, a number in the domain: refuse rather than round past 2^53. */
function toSequence(programId: string, sequence: bigint): number {
  const value = Number(sequence);
  if (!Number.isSafeInteger(value)) {
    throw new InvariantViolationError(
      `Program ${programId} has treasury sequence ${sequence}, which is too large to represent exactly.`,
    );
  }
  return value;
}

export function fromProgram(program: Program): Prisma.ProgramUncheckedCreateInput {
  return {
    id: program.id.value,
    currency: program.currency.code,
    creditLimitMinor: program.creditLimit.minorUnits,
    reservedMinor: program.reservedAmount.minorUnits,
    status: program.status,
    version: program.version,
    treasurySequence: BigInt(program.treasurySequence),
  };
}

export function toReservation(row: ReservationRecord): Reservation {
  const invoiceCurrency = Currency.of(row.invoiceCurrency);
  const reservedCurrency = Currency.of(row.reservedCurrency);

  return Reservation.rehydrate({
    id: ReservationId.of(row.id),
    programId: ProgramId.of(row.programId),
    invoiceId: InvoiceId.of(row.invoiceId),
    reservationKey: row.reservationKey === null ? null : ReservationKey.of(row.reservationKey),
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
    reservationKey: reservation.reservationKey?.value ?? null,
    invoiceCurrency: reservation.invoiceAmount.currency.code,
    invoiceMinor: reservation.invoiceAmount.minorUnits,
    reservedCurrency: reservation.reservedAmount.currency.code,
    reservedMinor: reservation.reservedAmount.minorUnits,
    // A decimal string, so the rate never passes through a float.
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
