import { Query } from '@nestjs/cqrs';
import type { ProgramId } from '../../domain/ids.js';
import type { ReservationStatus } from '../../domain/reservation.js';
import type { ReservationPage } from '../views.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface ListReservationsOptions {
  readonly status?: ReservationStatus | null;
  readonly limit?: number;
  /** A `nextCursor` from a previous page. */
  readonly cursor?: string | null;
}

export class ListReservationsQuery extends Query<ReservationPage> {
  constructor(
    readonly programId: ProgramId,
    readonly options: ListReservationsOptions = {},
  ) {
    super();
  }
}
