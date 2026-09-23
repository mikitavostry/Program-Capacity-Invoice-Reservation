import type { InvoiceId, ProgramId, ReservationId, ReservationKey } from '../ids.js';
import type { Reservation } from '../reservation.js';

export interface ReservationRepository {
  findById(id: ReservationId): Promise<Reservation | null>;

  /** An invoice holds at most one active reservation per program. */
  findActiveByInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<Reservation | null>;

  /** The reservation of an invoice made under this key, active or released. */
  findByKey(
    programId: ProgramId,
    invoiceId: InvoiceId,
    key: ReservationKey,
  ): Promise<Reservation | null>;

  /** Whether the invoice holds a fully repaid reservation against the program. */
  hasReleasedForInvoice(programId: ProgramId, invoiceId: InvoiceId): Promise<boolean>;

  insert(reservation: Reservation): Promise<void>;

  save(reservation: Reservation): Promise<void>;
}
