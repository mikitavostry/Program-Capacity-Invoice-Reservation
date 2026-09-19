import { Command } from '@nestjs/cqrs';
import type { Money } from '../../../../shared/money/money.js';
import type { ProgramId } from '../../domain/ids.js';
import type { TreasuryEventKind } from '../../domain/ports/treasury-event-log.js';
import type { ProgramCapacityView } from '../views.js';

export type TreasuryUpdateOutcome =
  /** The program now reflects this message. */
  | 'APPLIED'
  /** This event id was already recorded; nothing was written. */
  | 'DUPLICATE'
  /** Not newer than the state already applied; recorded and ignored. */
  | 'STALE';

export interface ApplyTreasuryUpdateResult {
  readonly outcome: TreasuryUpdateOutcome;
  /** The program as it stands; `null` when the message was a duplicate and nothing was read. */
  readonly program: ProgramCapacityView | null;
}

/**
 * State reported by the treasury system, for one program.
 *
 * Both kinds of message carry the program's full state rather than a delta, which is what
 * makes them safe to drop or reorder: the newest message wins and no history has to be
 * replayed to arrive at the right answer.
 */
export class ApplyTreasuryUpdateCommand extends Command<ApplyTreasuryUpdateResult> {
  constructor(
    readonly programId: ProgramId,
    /** The producer's id for this message; the deduplication key. */
    readonly eventId: string,
    readonly kind: TreasuryEventKind,
    /** Strictly increasing per program at the source. */
    readonly sequence: number,
    readonly creditLimit: Money,
    /** Treasury's view of what is reserved; compared and reported, never adopted. */
    readonly reportedReservedAmount: Money | null,
    readonly occurredAt: Date,
    /** The message as received, kept for the audit record. */
    readonly payload: unknown,
  ) {
    super();
  }
}
