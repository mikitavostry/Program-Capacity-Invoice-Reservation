import { DomainError } from '../../../../shared/domain/domain-error.js';
import type { ProgramId } from '../ids.js';

export type TreasuryEventKind = 'CAPACITY_CHANGED' | 'STATE_RECONCILED';

export interface TreasuryEventRecord {
  readonly programId: ProgramId;
  /** The producer's id for the message; the deduplication key. */
  readonly eventId: string;
  readonly kind: TreasuryEventKind;
  readonly sequence: number;
  /** Whether it changed anything. A message older than our state is recorded and ignored. */
  readonly applied: boolean;
  /** Why it was not applied, when it was not. */
  readonly reason: string | null;
  /** The message as received, so a decision can be re-examined against what actually arrived. */
  readonly payload: unknown;
  readonly occurredAt: Date;
}

/**
 * Every treasury message this service has accepted: the deduplication key and the audit
 * trail for capacity changes the service did not decide for itself.
 *
 * Written in the same transaction as the change it caused, so a message cannot be recorded
 * as applied unless its effect committed too.
 */
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
