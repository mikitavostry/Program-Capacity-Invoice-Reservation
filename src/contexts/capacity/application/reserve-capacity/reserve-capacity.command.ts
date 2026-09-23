import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { InvoiceId, ProgramId } from '../../domain/ids.js';
import type { ReservationView } from '../views.js';

export interface ReserveCapacityResult {
  readonly reservation: ReservationView;
  /** `false` when the invoice already held this reservation. */
  readonly created: boolean;
}

export class ReserveCapacityCommand extends Command<ReserveCapacityResult> {
  constructor(
    readonly programId: ProgramId,
    readonly invoiceId: InvoiceId,
    /** In the invoice's own currency; converted to the program's if they differ. */
    readonly invoiceAmount: Money,
  ) {
    super();
  }
}
