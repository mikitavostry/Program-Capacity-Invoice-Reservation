import { Body, Controller, Get, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequireScopes } from '../../../../iam/decorators.js';
import { Scopes } from '../../../../iam/principal.js';
import { ZodPipe } from '../../../../platform/http/request-validation.js';
import { ListReservationsQuery } from '../../application/list-reservations/list-reservations.query.js';
import { RecordRepaymentCommand } from '../../application/record-repayment/record-repayment.command.js';
import { ReserveCapacityCommand } from '../../application/reserve-capacity/reserve-capacity.command.js';
import { InvoiceId, ProgramId, RepaymentId } from '../../domain/ids.js';
import { presentRepayment, presentReservation, presentReservationPage } from './presenters.js';
import {
  identifier,
  listReservationsQuery,
  recordRepaymentBody,
  reserveCapacityBody,
} from './schemas.js';

@Controller('programs/:programId/reservations')
export class ReservationsController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  /** 201 for a new reservation; 200 when this repeats one the invoice already holds. */
  @Post()
  @RequireScopes(Scopes.ReservationsWrite)
  async reserve(
    @Param('programId', new ZodPipe(identifier, 'path')) programId: string,
    @Body(new ZodPipe(reserveCapacityBody, 'body')) body: z.output<typeof reserveCapacityBody>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.commands.execute(
      new ReserveCapacityCommand(
        ProgramId.of(programId),
        InvoiceId.of(body.invoiceId),
        body.invoiceAmount,
      ),
    );

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return presentReservation(result.reservation);
  }

  @Get()
  @RequireScopes(Scopes.CapacityRead)
  async list(
    @Param('programId', new ZodPipe(identifier, 'path')) programId: string,
    @Query(new ZodPipe(listReservationsQuery, 'query'))
    query: z.output<typeof listReservationsQuery>,
  ) {
    const page = await this.queries.execute(
      new ListReservationsQuery(ProgramId.of(programId), {
        status: query.status ?? null,
        limit: query.limit,
        cursor: query.cursor ?? null,
      }),
    );

    return presentReservationPage(page);
  }

  /** 201 when applied; 200 when this repayment id was already applied. */
  @Post(':invoiceId/repayments')
  @RequireScopes(Scopes.RepaymentsWrite)
  async repay(
    @Param('programId', new ZodPipe(identifier, 'path')) programId: string,
    @Param('invoiceId', new ZodPipe(identifier, 'path')) invoiceId: string,
    @Body(new ZodPipe(recordRepaymentBody, 'body')) body: z.output<typeof recordRepaymentBody>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.commands.execute(
      new RecordRepaymentCommand(
        ProgramId.of(programId),
        InvoiceId.of(invoiceId),
        RepaymentId.of(body.repaymentId),
        body.amount ?? null,
      ),
    );

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return presentRepayment(result);
  }
}
