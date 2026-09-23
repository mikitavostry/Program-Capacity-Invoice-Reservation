import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { ProgramId } from '../ids.js';

export type TreasuryEventKind = 'CAPACITY_CHANGED' | 'STATUS_CHANGED' | 'STATE_RECONCILED';

export interface TreasuryEventRecord {
  readonly programId: ProgramId;
  /** Treasury's id for the message; the deduplication key. */
  readonly eventId: string;
  readonly kind: TreasuryEventKind;
  readonly sequence: number;
  /** `false` for a stale message, with the `reason`. */
  readonly applied: boolean;
  readonly reason: string | null;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

/** Every treasury message accepted, written with its effect: deduplication and audit trail. */
export interface TreasuryEventLog {
  /** Rejects with `TreasuryEventAlreadyRecordedError` if this event id was recorded before. */
  record(entry: TreasuryEventRecord): Promise<void>;
}

export class TreasuryEventAlreadyRecordedError extends DomainError {
  readonly code = 'TREASURY_EVENT_ALREADY_RECORDED';

  constructor(readonly eventId: string) {
    super(`Treasury event ${eventId} has already been recorded.`);
  }
}
