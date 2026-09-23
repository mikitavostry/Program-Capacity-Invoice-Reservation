import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InvalidQueryError, ProgramNotFoundError } from '../errors.js';
import { CAPACITY_READ_MODEL, type CapacityReadModel } from '../ports/capacity-read-model.js';
import type { ReservationPage } from '../views.js';
import {
  DEFAULT_PAGE_SIZE,
  ListReservationsQuery,
  MAX_PAGE_SIZE,
} from './list-reservations.query.js';
import { decodeReservationCursor, encodeReservationCursor } from './reservation-cursor.js';

@QueryHandler(ListReservationsQuery)
export class ListReservationsHandler implements IQueryHandler<ListReservationsQuery> {
  constructor(@Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel) {}

  async execute(query: ListReservationsQuery): Promise<ReservationPage> {
    const limit = query.options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new InvalidQueryError(`A page size must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
    }

    const cursor = query.options.cursor ?? null;
    const after = cursor === null ? null : decodeReservationCursor(cursor);
    if (cursor !== null && after === null) {
      throw new InvalidQueryError('The cursor is not one this service issued.');
    }

    // 404 for an unknown program rather than an empty page.
    if ((await this.readModel.getProgramCapacity(query.programId)) === null) {
      throw new ProgramNotFoundError(query.programId);
    }

    // One extra row tells whether another page exists.
    const rows = await this.readModel.listReservations({
      programId: query.programId,
      status: query.options.status ?? null,
      limit: limit + 1,
      after,
    });

    const items = rows.slice(0, limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeReservationCursor({
              reservedAt: last.reservedAt,
              reservationId: last.reservationId,
            })
          : null,
    };
  }
}
