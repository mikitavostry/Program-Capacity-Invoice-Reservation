import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ProgramNotFoundError } from '../errors.js';
import { CAPACITY_READ_MODEL, type CapacityReadModel } from '../ports/capacity-read-model.js';
import type { ProgramCapacityView } from '../views.js';
import { GetProgramCapacityQuery } from './get-program-capacity.query.js';

@QueryHandler(GetProgramCapacityQuery)
export class GetProgramCapacityHandler implements IQueryHandler<GetProgramCapacityQuery> {
  constructor(@Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel) {}

  async execute(query: GetProgramCapacityQuery): Promise<ProgramCapacityView> {
    const view = await this.readModel.getProgramCapacity(query.programId);
    if (view === null) throw new ProgramNotFoundError(query.programId);

    return view;
  }
}
