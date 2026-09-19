import { describe, expect, it } from 'vitest';
import { Currency } from '../../../../shared/money/currency.js';
import { Money } from '../../../../shared/money/money.js';
import { TreasuryMessageError, toCommand } from './treasury-message.js';

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

describe('the treasury anti-corruption layer', () => {
  it('translates a capacity change into a command in our own language', () => {
    const command = toCommand(message());

    expect(command.programId.value).toBe('program-1');
    expect(command.eventId).toBe('treasury-event-1');
    expect(command.kind).toBe('CAPACITY_CHANGED');
    expect(command.sequence).toBe(7);
    expect(command.creditLimit.equals(Money.fromDecimal('2500000.00', USD))).toBe(true);
    expect(command.reportedReservedAmount).toBeNull();
    expect(command.occurredAt.toISOString()).toBe('2026-09-20T08:00:00.000Z');
  });

  it('carries treasury’s view of what is reserved on a reconciliation', () => {
    const command = toCommand(
      message({
        eventType: 'program.state.reconciled',
        program: {
          id: 'program-1',
          creditLimit: { amount: '2500000.00', currency: 'USD' },
          reservedAmount: { amount: '125000.00', currency: 'USD' },
        },
      }),
    );

    expect(command.kind).toBe('STATE_RECONCILED');
    expect(command.reportedReservedAmount?.equals(Money.fromDecimal('125000.00', USD))).toBe(true);
  });

  it('keeps the message exactly as it arrived, for the audit record', () => {
    const command = toCommand(message());

    expect(command.payload).toMatchObject({ eventId: 'treasury-event-1', sequence: 7 });
  });

  it.each([
    ['a body that is missing', null],
    ['a body that is not JSON', 'not json at all'],
    ['an unknown event type', message({ eventType: 'program.something.else' })],
    ['no event id', message({ eventId: '' })],
    ['a fractional sequence', message({ sequence: 1.5 })],
    ['a negative sequence', message({ sequence: -1 })],
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
      'an unexpected field, which may mean a contract change we have not read',
      message({
        program: { id: 'p-1', creditLimit: { amount: '1.00', currency: 'USD' }, limit: 5 },
      }),
    ],
  ])('refuses %s', (_, raw) => {
    expect(() => toCommand(raw as string | null)).toThrow(TreasuryMessageError);
  });

  it('says what was wrong, so a dead-lettered message can be diagnosed', () => {
    try {
      toCommand(message({ sequence: -1 }));
      expect.unreachable();
    } catch (error) {
      expect((error as TreasuryMessageError).issues).toEqual([expect.stringContaining('sequence')]);
    }
  });
});
