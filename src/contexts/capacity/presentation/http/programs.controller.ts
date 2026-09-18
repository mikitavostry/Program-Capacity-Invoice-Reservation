import { Body, Controller, Get, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequireScopes } from '../../../../iam/decorators.js';
import { Scopes } from '../../../../iam/principal.js';
import { ZodPipe } from '../../../../platform/http/request-validation.js';
import { GetProgramCapacityQuery } from '../../application/get-program-capacity/get-program-capacity.query.js';
import { OpenProgramCommand } from '../../application/open-program/open-program.command.js';
import { ProgramId } from '../../domain/ids.js';
import { presentProgram } from './presenters.js';
import { identifier, openProgramBody } from './schemas.js';

@Controller('programs')
export class ProgramsController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  /** 201 when the program is new; 200 when this repeats a request that already opened it. */
  @Post()
  @RequireScopes(Scopes.ProgramsAdmin)
  async open(
    @Body(new ZodPipe(openProgramBody, 'body')) body: z.output<typeof openProgramBody>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.commands.execute(
      new OpenProgramCommand(ProgramId.of(body.programId), body.creditLimit),
    );

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return presentProgram(result.program);
  }

  @Get(':programId/capacity')
  @RequireScopes(Scopes.CapacityRead)
  async capacity(@Param('programId', new ZodPipe(identifier, 'path')) programId: string) {
    const view = await this.queries.execute(new GetProgramCapacityQuery(ProgramId.of(programId)));

    return presentProgram(view);
  }
}
