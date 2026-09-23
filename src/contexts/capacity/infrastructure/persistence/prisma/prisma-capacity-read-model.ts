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

/** Views are built from rehydrated aggregates, so a corrupt row fails instead of being shown. */
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
