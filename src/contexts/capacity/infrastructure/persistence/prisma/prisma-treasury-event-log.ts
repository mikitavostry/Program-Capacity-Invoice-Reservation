import type { Prisma } from '../../../../../generated/prisma/client.js';
import {
  TreasuryEventAlreadyRecordedError,
  type TreasuryEventLog,
  type TreasuryEventRecord,
} from '../../../domain/ports/treasury-event-log.js';
import { isUniqueViolation } from './postgres-errors.js';

export class PrismaTreasuryEventLog implements TreasuryEventLog {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async record(entry: TreasuryEventRecord): Promise<void> {
    try {
      await this.tx.treasuryEvent.create({
        data: {
          programId: entry.programId.value,
          eventId: entry.eventId,
          kind: entry.kind,
          sequence: BigInt(entry.sequence),
          applied: entry.applied,
          reason: entry.reason,
          // Stored as received. A decision about capacity should be answerable against the
          // message that caused it, not a reconstruction of it.
          payload: entry.payload as Prisma.InputJsonValue,
          occurredAt: entry.occurredAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new TreasuryEventAlreadyRecordedError(entry.eventId);
      throw error;
    }
  }
}
