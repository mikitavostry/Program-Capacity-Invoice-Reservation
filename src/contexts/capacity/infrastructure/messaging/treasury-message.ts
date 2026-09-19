import { z } from 'zod';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import {
  ApplyTreasuryUpdateCommand,
  type ApplyTreasuryUpdateResult,
} from '../../application/apply-treasury-update/apply-treasury-update.command.js';
import { ProgramId } from '../../domain/ids.js';
import type { TreasuryEventKind } from '../../domain/ports/treasury-event-log.js';

/*
 * The anti-corruption layer for the treasury feed.
 *
 * Treasury's wire format is theirs, and deliberately not ours: their field names, their
 * envelope, their event type strings. This module is the single place that knows about it, so
 * a change at their end is a change here and nowhere else. What leaves this file is a command
 * in our own language, holding our own value objects.
 */

const money = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .transform((value, ctx): Money => {
    try {
      return Money.fromDecimal(value.amount, Currency.of(value.currency));
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

/** Treasury's event type strings, mapped to what they mean here. */
const EVENT_KINDS: Readonly<Record<string, TreasuryEventKind>> = {
  'program.capacity.changed': 'CAPACITY_CHANGED',
  'program.state.reconciled': 'STATE_RECONCILED',
};

const treasuryMessageSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.enum(Object.keys(EVENT_KINDS) as [string, ...string[]]),
  occurredAt: z.iso.datetime({ offset: true }),
  /** Strictly increasing per program at the source; how we order and de-duplicate. */
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  program: z
    .object({
      id: z.string().min(1).max(128),
      creditLimit: money,
      /**
       * Only bulk reconciliation carries treasury's view of what is reserved; an incremental
       * capacity change does not claim to know it.
       */
      reservedAmount: money.optional(),
    })
    .strict(),
});

export type TreasuryMessage = z.output<typeof treasuryMessageSchema>;

export class TreasuryMessageError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TreasuryMessageError';
  }
}

/**
 * Turns raw message bytes into a command, or rejects them.
 *
 * Anything this throws on can never succeed by being retried — the bytes will not change — so
 * the consumer parks it in the dead-letter topic rather than blocking the partition behind it.
 */
export function toCommand(raw: Buffer | string | null): ApplyTreasuryUpdateCommand {
  if (raw === null) {
    throw new TreasuryMessageError('The message has no body.');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new TreasuryMessageError(`The message is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = treasuryMessageSchema.safeParse(json);
  if (!parsed.success) {
    throw new TreasuryMessageError(
      'The message does not match the treasury schema.',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const message = parsed.data;
  const kind = EVENT_KINDS[message.eventType] as TreasuryEventKind;

  return new ApplyTreasuryUpdateCommand(
    ProgramId.of(message.program.id),
    message.eventId,
    kind,
    message.sequence,
    message.program.creditLimit,
    message.program.reservedAmount ?? null,
    new Date(message.occurredAt),
    json,
  );
}

export type { ApplyTreasuryUpdateResult };
