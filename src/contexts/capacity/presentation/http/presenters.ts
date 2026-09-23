import type { Money } from '../../../../shared/money/money.js';
import type { RecordRepaymentResult } from '../../application/record-repayment/record-repayment.command.js';
import type {
  ProgramCapacityView,
  ReservationPage,
  ReservationView,
} from '../../application/views.js';

/* The response contract, spelled out so an internal rename cannot change what clients get. */

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

const money = (value: Money): MoneyJson => ({
  amount: value.toDecimalString(),
  currency: value.currency.code,
});

export function presentProgram(view: ProgramCapacityView) {
  return {
    programId: view.programId,
    currency: view.currency.code,
    status: view.status,
    creditLimit: money(view.creditLimit),
    reservedAmount: money(view.reservedAmount),
    availableCapacity: money(view.availableCapacity),
  };
}

export function presentReservation(view: ReservationView) {
  const rate = view.exchangeRate;

  return {
    reservationId: view.reservationId,
    programId: view.programId,
    invoiceId: view.invoiceId,
    reservationKey: view.reservationKey,
    status: view.status,
    invoiceAmount: money(view.invoiceAmount),
    reservedAmount: money(view.reservedAmount),
    exchangeRate:
      rate === null
        ? null
        : {
            from: rate.from.code,
            to: rate.to.code,
            rate: rate.rate,
            asOf: rate.asOf.toISOString(),
          },
    repaidAmount: money(view.repaidAmount),
    releasedAmount: money(view.releasedAmount),
    outstandingAmount: money(view.outstandingAmount),
    heldAmount: money(view.heldAmount),
    reservedAt: view.reservedAt.toISOString(),
    releasedAt: view.releasedAt?.toISOString() ?? null,
  };
}

export function presentRepayment(result: RecordRepaymentResult) {
  return {
    repaymentId: result.repaymentId,
    repaidAmount: money(result.repaidAmount),
    releasedAmount: money(result.releasedAmount),
    reservation: presentReservation(result.reservation),
  };
}

export function presentReservationPage(page: ReservationPage) {
  return {
    items: page.items.map(presentReservation),
    nextCursor: page.nextCursor,
  };
}
