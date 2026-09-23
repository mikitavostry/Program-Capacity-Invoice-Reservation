import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { InvoiceId, ProgramId, RepaymentId } from '../../domain/ids.js';
import type { ReservationView } from '../views.js';

export interface RecordRepaymentResult {
  readonly repaymentId: string;
  /** In the invoice's currency. */
  readonly repaidAmount: Money;
  /** Capacity this repayment freed, in the program's currency. May be zero. */
  readonly releasedAmount: Money;
  readonly reservation: ReservationView;
  readonly replayed: boolean;
}

export class RecordRepaymentCommand extends Command<RecordRepaymentResult> {
  constructor(
    readonly programId: ProgramId,
    readonly invoiceId: InvoiceId,
    /** The idempotency key. */
    readonly repaymentId: RepaymentId,
    /** In the invoice's currency. `null` repays whatever is outstanding. */
    readonly amount: Money | null,
  ) {
    super();
  }
}
