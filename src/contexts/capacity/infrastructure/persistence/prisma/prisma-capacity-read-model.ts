import type { Prisma, PrismaClient } from '../../../../../generated/prisma/client.js';
import type {
  CapacityReadModel,
  ReservationListRequest,
} from '../../../application/ports/capacity-read-model.js';
import {
  toProgramCapacityView,
  toReservationView,
  type ProgramCapacityView,
  type ReservationView,
} from '../../../application/views.js';
import type { ProgramId } from '../../../domain/ids.js';
import { toProgram, toReservation } from './mappers.js';

/**
 * Reads go through the same mappers as writes, so a view is built from a rehydrated aggregate
 * and a corrupt row fails here too instead of being displayed. At page sizes of a hundred the
 * cost is negligible; a hot read path could later read columns straight into views.
 */
export class PrismaCapacityReadModel implements CapacityReadModel {
  constructor(private readonly prisma: PrismaClient) {}

  async getProgramCapacity(programId: ProgramId): Promise<ProgramCapacityView | null> {
    const row = await this.prisma.program.findUnique({ where: { id: programId.value } });

    return row === null ? null : toProgramCapacityView(toProgram(row));
  }

  async listReservations(request: ReservationListRequest): Promise<ReservationView[]> {
    const where: Prisma.ReservationWhereInput = { programId: request.programId.value };

    if (request.status !== null) where.status = request.status;

    if (request.after !== null) {
      const { reservedAt, reservationId } = request.after;
      where.OR = [{ reservedAt: { lt: reservedAt } }, { reservedAt, id: { lt: reservationId } }];
    }

    const rows = await this.prisma.reservation.findMany({
      where,
      orderBy: [{ reservedAt: 'desc' }, { id: 'desc' }],
      take: request.limit,
    });

    return rows.map((row) => toReservationView(toReservation(row)));
  }
}
