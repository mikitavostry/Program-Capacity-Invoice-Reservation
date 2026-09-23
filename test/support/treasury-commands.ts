import { randomUUID } from 'node:crypto';
import { ApplyTreasuryUpdateCommand } from '../../src/contexts/capacity/application/apply-treasury-update/apply-treasury-update.command.js';
import type { ProgramId } from '../../src/contexts/capacity/domain/ids.js';
import type { TreasuryEventKind } from '../../src/contexts/capacity/domain/ports/treasury-event-log.js';
import type { ProgramStatus } from '../../src/contexts/capacity/domain/program.js';
import type { Money } from '../../src/shared/money/money.js';

export interface TreasuryUpdateOptions {
  readonly programId: ProgramId;
  /** `null` for a status change, which carries no limit. */
  readonly creditLimit: Money | null;
  /** `STATE_RECONCILED` for a periodic reconciliation; a capacity change otherwise. */
  readonly kind?: TreasuryEventKind;
  readonly sequence?: number;
  readonly status?: ProgramStatus | null;
  readonly eventId?: string;
  readonly at?: Date;
}

/** A treasury message as the feed would hand it to the application. */
export function treasuryUpdate(options: TreasuryUpdateOptions): ApplyTreasuryUpdateCommand {
  const eventId = options.eventId ?? `treasury-${randomUUID()}`;
  const sequence = options.sequence ?? 0;

  return new ApplyTreasuryUpdateCommand(
    options.programId,
    eventId,
    options.kind ?? 'CAPACITY_CHANGED',
    sequence,
    options.creditLimit,
    options.at ?? new Date('2026-09-19T08:30:00.000Z'),
    { eventId, sequence },
    options.status ?? null,
  );
}

/**
 * The message that opens a program: sequence 0, so any later message a test sends — from
 * sequence 1 — is newer and applies.
 */
export const openingMessage = (programId: ProgramId, creditLimit: Money) =>
  treasuryUpdate({ programId, creditLimit, sequence: 0 });
