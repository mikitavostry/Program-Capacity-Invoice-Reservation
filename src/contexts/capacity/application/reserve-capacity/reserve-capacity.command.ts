import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { InvoiceId, ProgramId, ReservationKey } from '../../domain/ids.js';
import type { ReservationView } from '../views.js';

export interface ReserveCapacityResult {
  readonly reservation: ReservationView;
  /** `false` when this request repeats an existing reservation. */
  readonly created: boolean;
}

export class ReserveCapacityCommand extends Command<ReserveCapacityResult> {
  constructor(
    readonly programId: ProgramId,
    readonly invoiceId: InvoiceId,
    /** In the invoice's own currency; converted to the program's if they differ. */
    readonly invoiceAmount: Money,
    /**
     * Names this reservation of the invoice. Optional the first time; required to reserve an
     * invoice again once it has been fully repaid. A key is an idempotency key for good: its
     * retries are answered with its reservation even after that one is released.
     */
    readonly reservationKey: ReservationKey | null = null,
  ) {
    super();
  }
}
