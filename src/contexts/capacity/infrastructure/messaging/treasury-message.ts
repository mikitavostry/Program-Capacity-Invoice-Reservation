import { z } from 'zod';
import { Currency } from '../../../../shared/money/currency.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { MAX_MINOR_UNITS, Money } from '../../../../shared/money/money.js';
import { ApplyTreasuryUpdateCommand } from '../../application/apply-treasury-update/apply-treasury-update.command.js';
import { EXTERNAL_ID_PATTERN, EXTERNAL_ID_RULE, ProgramId } from '../../domain/ids.js';
import { PROGRAM_STATUSES } from '../../domain/program.js';
import type { TreasuryEventKind } from '../../domain/ports/treasury-event-log.js';

const money = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .transform((value, ctx): Money => {
    let amount: Money;
    try {
      amount = Money.fromDecimal(value.amount, Currency.of(value.currency));
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
    if (amount.minorUnits > MAX_MINOR_UNITS || -amount.minorUnits > MAX_MINOR_UNITS) {
      ctx.addIssue({ code: 'custom', message: 'is too large to store' });
      return z.NEVER;
    }
    return amount;
  });

// Postgres rejects NUL in text and jsonb, which would fail the write on every redelivery.
const noNul = (value: string) => !value.includes('\u0000');

const EVENT_KINDS = {
  'program.capacity.changed': 'CAPACITY_CHANGED',
  'program.status.changed': 'STATUS_CHANGED',
  'program.state.reconciled': 'STATE_RECONCILED',
} as const satisfies Record<string, TreasuryEventKind>;

const envelope = {
  eventId: z.string().min(1).max(200).refine(noNul, 'must not contain NUL characters'),
  occurredAt: z.iso.datetime({ offset: true }),
  /** Strictly increasing per program across all event types. */
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
// The same rule as the HTTP API's: a program opened here must be addressable in a URL.
const programId = z.string().trim().regex(EXTERNAL_ID_PATTERN, EXTERNAL_ID_RULE);
const status = z.enum(PROGRAM_STATUSES);

/*
 * A capacity change carries the limit, a status change the status, and a reconciliation both:
 * the program's full treasury-owned state, correcting anything an earlier message missed.
 * Unknown fields are rejected.
 */
const treasuryMessageSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...envelope,
    eventType: z.literal('program.capacity.changed'),
    program: z.object({ id: programId, creditLimit: money }).strict(),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('program.status.changed'),
    program: z.object({ id: programId, status }).strict(),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('program.state.reconciled'),
    program: z.object({ id: programId, creditLimit: money, status }).strict(),
  }),
]);

export class TreasuryMessageError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TreasuryMessageError';
  }
}

/** Parses message bytes into a command. Throws only `TreasuryMessageError`, which is permanent. */
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
  const { program } = message;

  try {
    return new ApplyTreasuryUpdateCommand(
      ProgramId.of(program.id),
      message.eventId,
      EVENT_KINDS[message.eventType],
      message.sequence,
      'creditLimit' in program ? program.creditLimit : null,
      new Date(message.occurredAt),
      json,
      'status' in program ? program.status : null,
    );
  } catch (error) {
    if (error instanceof DomainError) throw new TreasuryMessageError(error.message);
    throw error;
  }
}
