import type { ProgramId } from '../../domain/ids.js';
import type { ReservationStatus } from '../../domain/reservation.js';
import type { ProgramCapacityView, ReservationView } from '../views.js';

/** A position in the newest-first list of a program's reservations. */
export interface ReservationCursor {
  readonly reservedAt: Date;
  readonly reservationId: string;
}

export interface ReservationListRequest {
  readonly programId: ProgramId;
  readonly status: ReservationStatus | null;
  readonly limit: number;
  /** Return only reservations after this position; `null` for the first page. */
  readonly after: ReservationCursor | null;
}

/**
 * The query side: reads without locks, for answering questions rather than making decisions.
 *
 * Nothing read here may be used to decide whether capacity is available — that check happens
 * only against a locked program inside a transaction. The one command-side use is reading a
 * program's currency before a reservation, which is safe because a currency never changes.
 */
export interface CapacityReadModel {
  getProgramCapacity(programId: ProgramId): Promise<ProgramCapacityView | null>;

  /** Newest first, ordered by reservation time and then id, so every position is unique. */
  listReservations(request: ReservationListRequest): Promise<ReservationView[]>;
}

export const CAPACITY_READ_MODEL = Symbol('CapacityReadModel');
