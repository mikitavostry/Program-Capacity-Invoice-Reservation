import type { Prisma } from '../../../../../generated/prisma/client.js';
import type { InvoiceId, ProgramId, ReservationId, ReservationKey } from '../../../domain/ids.js';
import type { ReservationRepository } from '../../../domain/ports/reservation-repository.js';
import type { Reservation } from '../../../domain/reservation.js';
import { fromReservation, toReservation } from './mappers.js';

export class PrismaReservationRepository implements ReservationRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async findById(id: ReservationId): Promise<Reservation | null> {
    const row = await this.tx.reservation.findUnique({ where: { id: id.value } });

    return row === null ? null : toReservation(row);
  }

  async findActiveByInvoice(
    programId: ProgramId,
    invoiceId: InvoiceId,
  ): Promise<Reservation | null> {
    const row = await this.tx.reservation.findFirst({
      where: { programId: programId.value, invoiceId: invoiceId.value, status: 'ACTIVE' },
    });

    return row === null ? null : toReservation(row);
  }

  async findByKey(
    programId: ProgramId,
    invoiceId: InvoiceId,
    key: ReservationKey,
  ): Promise<Reservation | null> {
    const row = await this.tx.reservation.findUnique({
      where: {
        programId_invoiceId_reservationKey: {
          programId: programId.value,
          invoiceId: invoiceId.value,
          reservationKey: key.value,
        },
      },
    });

    return row === null ? null : toReservation(row);
  }

  async hasReleasedForInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<boolean> {
    const row = await this.tx.reservation.findFirst({
      where: { programId: programId.value, invoiceId: invoiceId.value, status: 'RELEASED' },
      select: { id: true },
    });

    return row !== null;
  }

  async insert(reservation: Reservation): Promise<void> {
    await this.tx.reservation.create({ data: fromReservation(reservation) });
  }

  async save(reservation: Reservation): Promise<void> {
    // Only what a repayment changes; the rest is fixed at creation.
    await this.tx.reservation.update({
      where: { id: reservation.id.value },
      data: {
        repaidMinor: reservation.repaidAmount.minorUnits,
        releasedMinor: reservation.releasedAmount.minorUnits,
        status: reservation.status,
        releasedAt: reservation.releasedAt,
      },
    });
  }
}
