import type { ProgramId } from '../../domain/ids.js';
import type { ReservationStatus } from '../../domain/reservation.js';
import type { ProgramCapacityView, ReservationView } from '../views.js';

export interface ReservationCursor {
  readonly reservedAt: Date;
  readonly reservationId: string;
}

export interface ReservationListRequest {
  readonly programId: ProgramId;
  readonly status: ReservationStatus | null;
  readonly limit: number;
  readonly after: ReservationCursor | null;
}

/**
 * Unlocked reads for queries. Never use them to decide whether capacity is available; that
 * happens only against a locked program.
 */
export interface CapacityReadModel {
  getProgramCapacity(programId: ProgramId): Promise<ProgramCapacityView | null>;

  /** Newest first, by reservation time then id. */
  listReservations(request: ReservationListRequest): Promise<ReservationView[]>;
}

export const CAPACITY_READ_MODEL = Symbol('CapacityReadModel');
