import type { InvoiceId, ProgramId, ReservationId } from '../ids.js';
import type { Reservation } from '../reservation.js';

export interface ReservationRepository {
  findById(id: ReservationId): Promise<Reservation | null>;

  /** An invoice holds at most one active reservation per program. */
  findActiveByInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<Reservation | null>;

  insert(reservation: Reservation): Promise<void>;

  save(reservation: Reservation): Promise<void>;
}
