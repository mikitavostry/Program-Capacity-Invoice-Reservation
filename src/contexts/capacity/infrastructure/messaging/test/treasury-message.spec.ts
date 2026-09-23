import { describe, expect, it } from 'vitest';
import { ApplyTreasuryUpdateCommand } from '../../../application/apply-treasury-update/apply-treasury-update.command.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import { TreasuryMessageError, toCommand } from '../treasury-message.js';

const USD = Currency.of('USD');

const message = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventId: 'treasury-event-1',
    eventType: 'program.capacity.changed',
    occurredAt: '2026-09-20T08:00:00.000Z',
    sequence: 7,
    program: { id: 'program-1', creditLimit: { amount: '2500000.00', currency: 'USD' } },
    ...overrides,
  });

/** A message, parsed. */
function update(raw: string): ApplyTreasuryUpdateCommand {
  const command = toCommand(raw);
  if (!(command instanceof ApplyTreasuryUpdateCommand)) throw new Error('not a single update');
  return command;
}

function issuesOf(raw: string): readonly string[] {
  try {
    toCommand(raw);
  } catch (error) {
    if (error instanceof TreasuryMessageError) return error.issues;
    throw error;
  }
  throw new Error('the message was accepted');
}

describe('the treasury anti-corruption layer', () => {
  describe('a capacity change', () => {
    it('translates into a command in our own language', () => {
      const command = update(message());

      expect(command.programId.value).toBe('program-1');
      expect(command.eventId).toBe('treasury-event-1');
      expect(command.kind).toBe('CAPACITY_CHANGED');
      expect(command.sequence).toBe(7);
      expect(command.creditLimit?.equals(Money.fromDecimal('2500000.00', USD))).toBe(true);
      expect(command.status).toBeNull();
      expect(command.occurredAt.toISOString()).toBe('2026-09-20T08:00:00.000Z');
    });

    it('keeps the message exactly as it arrived, for the audit record', () => {
      expect(update(message()).payload).toMatchObject({ eventId: 'treasury-event-1', sequence: 7 });
    });
  });

  describe('a status change', () => {
    it('translates into a command that leaves the limit alone', () => {
      const command = update(
        message({
          eventType: 'program.status.changed',
          program: { id: 'program-1', status: 'SUSPENDED' },
        }),
      );

      expect(command.kind).toBe('STATUS_CHANGED');
      expect(command.status).toBe('SUSPENDED');
      expect(command.creditLimit).toBeNull();
    });
  });

  describe('a reconciliation', () => {
    const reconciled = (program: Record<string, unknown>) =>
      message({ eventType: 'program.state.reconciled', program });

    it('translates into one program’s full state, marked as a reconciliation', () => {
      const command = update(
        reconciled({
          id: 'program-1',
          creditLimit: { amount: '2500000.00', currency: 'USD' },
          status: 'SUSPENDED',
        }),
      );

      expect(command.kind).toBe('STATE_RECONCILED');
      expect(command.creditLimit?.equals(Money.fromDecimal('2500000.00', USD))).toBe(true);
      expect(command.status).toBe('SUSPENDED');
    });

    it.each([
      [
        'without a status, since it must be the full state',
        reconciled({ id: 'program-1', creditLimit: { amount: '1.00', currency: 'USD' } }),
        'program.status',
      ],
      [
        'without a limit, since it must be the full state',
        reconciled({ id: 'program-1', status: 'ACTIVE' }),
        'program.creditLimit',
      ],
    ])('refuses one %s', (_, raw, path) => {
      expect(issuesOf(raw)).toEqual(expect.arrayContaining([expect.stringContaining(path)]));
    });
  });

  it.each([
    ['a body that is missing', null],
    ['a body that is not JSON', 'not json at all'],
    ['an unknown event type', message({ eventType: 'program.something.else' })],
    ['no event id', message({ eventId: '' })],
    ['a fractional sequence', message({ sequence: 1.5 })],
    ['a negative sequence', message({ sequence: -1 })],
    [
      'a reserved amount, which treasury does not own',
      message({
        program: {
          id: 'program-1',
          creditLimit: { amount: '1.00', currency: 'USD' },
          reservedAmount: { amount: '1.00', currency: 'USD' },
        },
      }),
    ],
    [
      'a status it does not know',
      message({
        eventType: 'program.status.changed',
        program: { id: 'program-1', status: 'CLOSED' },
      }),
    ],
    [
      'a status on a capacity change, which carries only the limit',
      message({
        program: {
          id: 'program-1',
          creditLimit: { amount: '1.00', currency: 'USD' },
          status: 'SUSPENDED',
        },
      }),
    ],
    [
      'a limit on a status change, which carries only the status',
      message({
        eventType: 'program.status.changed',
        program: {
          id: 'program-1',
          creditLimit: { amount: '1.00', currency: 'USD' },
          status: 'SUSPENDED',
        },
      }),
    ],
    [
      'a status change without a status',
      message({ eventType: 'program.status.changed', program: { id: 'program-1' } }),
    ],
    ['a timestamp that is not a timestamp', message({ occurredAt: 'yesterday' })],
    [
      'an amount as a JSON number',
      message({ program: { id: 'program-1', creditLimit: { amount: 2500000, currency: 'USD' } } }),
    ],
    [
      'a currency we do not support',
      message({ program: { id: 'p-1', creditLimit: { amount: '1.00', currency: 'XYZ' } } }),
    ],
    [
      'more decimals than the currency has',
      message({ program: { id: 'p-1', creditLimit: { amount: '1.001', currency: 'USD' } } }),
    ],
    [
      'a program id of only spaces',
      message({ program: { id: '   ', creditLimit: { amount: '1.00', currency: 'USD' } } }),
    ],
    [
      'a program id the HTTP API could never address',
      message({ program: { id: 'EU/2026', creditLimit: { amount: '1.00', currency: 'USD' } } }),
    ],
    [
      'a program id with a space in it',
      message({ program: { id: 'program 7', creditLimit: { amount: '1.00', currency: 'USD' } } }),
    ],
    [
      'a limit too large for the database to store',
      message({
        program: {
          id: 'p-1',
          creditLimit: { amount: '100000000000000000000.00', currency: 'USD' },
        },
      }),
    ],
    ['a NUL character, which the database cannot store', message({ eventId: 'event\u0000-1' })],
    [
      'an unexpected field, which may mean a contract change we have not read',
      message({
        program: { id: 'p-1', creditLimit: { amount: '1.00', currency: 'USD' }, limit: 5 },
      }),
    ],
  ])('refuses %s', (_, raw) => {
    expect(() => toCommand(raw as string | null)).toThrow(TreasuryMessageError);
  });

  it('says what was wrong, so a dead-lettered message can be diagnosed', () => {
    expect(issuesOf(message({ sequence: -1 }))).toEqual([expect.stringContaining('sequence')]);
  });
});
