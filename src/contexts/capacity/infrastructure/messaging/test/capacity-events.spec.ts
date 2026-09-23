import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { Currency } from '../../../../../shared/money/currency.js';
import { Money } from '../../../../../shared/money/money.js';
import {
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
  ProgramStatusChanged,
} from '../../../domain/events.js';
import { InvoiceId, ProgramId, RepaymentId, ReservationId } from '../../../domain/ids.js';
import { toCapacityEventMessage } from '../capacity-events.js';

const usd = (amount: string): Money => Money.fromDecimal(amount, Currency.of('USD'));
const eur = (amount: string): Money => Money.fromDecimal(amount, Currency.of('EUR'));
const PROGRAM = ProgramId.of('program-1');
const AT = new Date('2026-09-22T10:00:00.000Z');

describe('the published capacity events', () => {
  it('wrap every event in the same envelope', () => {
    const message = toCapacityEventMessage(
      'event-1',
      new ProgramOpened(PROGRAM, usd('1000.00'), AT),
    );

    expect(message).toEqual({
      eventId: 'event-1',
      eventType: 'capacity.program-opened',
      occurredAt: '2026-09-22T10:00:00.000Z',
      programId: 'program-1',
      data: { creditLimit: { amount: '1000.00', currency: 'USD' } },
    });
  });

  it('describe a reservation in both currencies, amounts as decimal strings', () => {
    const message = toCapacityEventMessage(
      'event-1',
      new CapacityReserved({
        programId: PROGRAM,
        reservationId: ReservationId.of('reservation-1'),
        invoiceId: InvoiceId.of('invoice-1'),
        invoiceAmount: eur('100.00'),
        reservedAmount: usd('109.00'),
        availableAfter: usd('891.00'),
        occurredAt: AT,
      }),
    );

    expect(message.eventType).toBe('capacity.reserved');
    expect(message.data).toEqual({
      reservationId: 'reservation-1',
      invoiceId: 'invoice-1',
      invoiceAmount: { amount: '100.00', currency: 'EUR' },
      reservedAmount: { amount: '109.00', currency: 'USD' },
      availableAfter: { amount: '891.00', currency: 'USD' },
    });
  });

  it('describe a release with the repayment that caused it', () => {
    const message = toCapacityEventMessage(
      'event-1',
      new CapacityReleased({
        programId: PROGRAM,
        reservationId: ReservationId.of('reservation-1'),
        invoiceId: InvoiceId.of('invoice-1'),
        repaymentId: RepaymentId.of('repayment-1'),
        repaidAmount: eur('40.00'),
        releasedAmount: usd('43.60'),
        reservationFullyReleased: false,
        availableAfter: usd('934.60'),
        occurredAt: AT,
      }),
    );

    expect(message.eventType).toBe('capacity.released');
    expect(message.data).toMatchObject({
      repaymentId: 'repayment-1',
      repaidAmount: { amount: '40.00', currency: 'EUR' },
      releasedAmount: { amount: '43.60', currency: 'USD' },
      reservationFullyReleased: false,
    });
  });

  it('describe a limit change, including whether it left the program over limit', () => {
    const message = toCapacityEventMessage(
      'event-1',
      new CreditLimitChanged({
        programId: PROGRAM,
        previousLimit: usd('1000.00'),
        creditLimit: usd('500.00'),
        reservedAmount: usd('800.00'),
        treasurySequence: 7,
        occurredAt: AT,
      }),
    );

    expect(message.eventType).toBe('capacity.credit-limit-changed');
    expect(message.data).toEqual({
      previousLimit: { amount: '1000.00', currency: 'USD' },
      creditLimit: { amount: '500.00', currency: 'USD' },
      reservedAmount: { amount: '800.00', currency: 'USD' },
      overLimit: true,
    });
  });

  it('describe a status change', () => {
    const message = toCapacityEventMessage(
      'event-1',
      new ProgramStatusChanged({
        programId: PROGRAM,
        previousStatus: 'ACTIVE',
        status: 'SUSPENDED',
        treasurySequence: 7,
        occurredAt: AT,
      }),
    );

    expect(message.eventType).toBe('capacity.program-status-changed');
    expect(message.data).toEqual({ previousStatus: 'ACTIVE', status: 'SUSPENDED' });
  });

  it('refuse an event with no published contract, rather than silently not announcing it', () => {
    const unknown: DomainEvent = { eventName: 'SomethingNew', aggregateId: 'p', occurredAt: AT };

    expect(() => toCapacityEventMessage('event-1', unknown)).toThrow(InvariantViolationError);
  });
});
