import type { InvoiceId, ProgramId, ReservationId } from '../ids.js';
import type { Reservation } from '../reservation.js';

export interface ReservationRepository {
  findById(id: ReservationId): Promise<Reservation | null>;

  /** The reservation an invoice currently holds against a program, if any — at most one. */
  findActiveByInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<Reservation | null>;

  insert(reservation: Reservation): Promise<void>;

  save(reservation: Reservation): Promise<void>;
}
