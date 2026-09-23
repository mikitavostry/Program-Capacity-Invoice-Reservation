import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { ProgramId } from '../../domain/ids.js';
import type { ProgramStatus } from '../../domain/program.js';
import type { TreasuryEventKind } from '../../domain/ports/treasury-event-log.js';
import type { ProgramCapacityView } from '../views.js';

export type TreasuryUpdateOutcome =
  | 'CREATED'
  | 'APPLIED'
  /** This event id was already recorded; nothing was written. */
  | 'DUPLICATE'
  /** Not newer than the state already applied; recorded and ignored. */
  | 'STALE';

export interface ApplyTreasuryUpdateResult {
  readonly outcome: TreasuryUpdateOutcome;
  /** `null` for a duplicate. */
  readonly program: ProgramCapacityView | null;
}

/**
 * One treasury message for one program. Each carries absolute values (a limit, a status, or
 * both for a reconciliation), never a delta, so the newest sequence wins and a message lost or
 * reordered is corrected by the next one.
 */
export class ApplyTreasuryUpdateCommand extends Command<ApplyTreasuryUpdateResult> {
  constructor(
    readonly programId: ProgramId,
    /** Treasury's id for this message; the deduplication key. */
    readonly eventId: string,
    readonly kind: TreasuryEventKind,
    /** Strictly increasing per program at the source. */
    readonly sequence: number,
    /** `null` leaves the limit unchanged. */
    readonly creditLimit: Money | null,
    readonly occurredAt: Date,
    readonly payload: unknown,
    /** `null` leaves the status unchanged. */
    readonly status: ProgramStatus | null = null,
  ) {
    super();
  }
}
