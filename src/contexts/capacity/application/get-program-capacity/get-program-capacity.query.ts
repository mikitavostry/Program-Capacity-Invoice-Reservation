import { Query } from '@nestjs/cqrs';
import type { ProgramId } from '../../domain/ids.js';
import type { ProgramCapacityView } from '../views.js';

export class GetProgramCapacityQuery extends Query<ProgramCapacityView> {
  constructor(readonly programId: ProgramId) {
    super();
  }
}
