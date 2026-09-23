import { Controller, Get, Param } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { RequireScopes } from '../../../../iam/decorators.js';
import { Scopes } from '../../../../iam/principal.js';
import { ZodPipe } from '../../../../platform/http/request-validation.js';
import { GetProgramCapacityQuery } from '../../application/get-program-capacity/get-program-capacity.query.js';
import { ProgramId } from '../../domain/ids.js';
import { presentProgram } from './presenters.js';
import { identifier } from './schemas.js';

/** Programs are opened and updated by the treasury feed; over HTTP they are read-only. */
@Controller('programs')
export class ProgramsController {
  constructor(private readonly queries: QueryBus) {}

  @Get(':programId/capacity')
  @RequireScopes(Scopes.CapacityRead)
  async capacity(@Param('programId', new ZodPipe(identifier, 'path')) programId: string) {
    const view = await this.queries.execute(new GetProgramCapacityQuery(ProgramId.of(programId)));

    return presentProgram(view);
  }
}
