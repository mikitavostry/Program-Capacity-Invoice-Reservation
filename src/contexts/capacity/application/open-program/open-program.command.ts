import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { ProgramId } from '../../domain/ids.js';
import type { ProgramCapacityView } from '../views.js';

export interface OpenProgramResult {
  readonly program: ProgramCapacityView;
  /** `false` when this repeated an earlier, identical request. */
  readonly created: boolean;
}

/**
 * Opens a program under an id the caller chooses. Programs are defined upstream, and the
 * treasury feed will refer to them by those same ids, so the id is an input, not an output —
 * which also makes a retried request recognisable.
 */
export class OpenProgramCommand extends Command<OpenProgramResult> {
  constructor(
    readonly programId: ProgramId,
    readonly creditLimit: Money,
  ) {
    super();
  }
}
