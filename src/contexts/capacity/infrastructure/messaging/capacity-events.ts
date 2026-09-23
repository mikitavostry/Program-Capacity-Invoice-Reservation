import type { DomainEvent } from '../../../../shared/domain/domain-event.js';
import { InvariantViolationError } from '../../../../shared/domain/invariant-violation-error.js';
import {
  CapacityReleased,
  CapacityReserved,
  CreditLimitChanged,
  ProgramOpened,
  ProgramStatusChanged,
} from '../../domain/events.js';

export interface CapacityEventMessage {
  /** Stable across redeliveries, for consumers to deduplicate on. */
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  /** Also the message key, so one program's events stay in order. */
  readonly programId: string;
  readonly data: Record<string, unknown>;
}

export function toCapacityEventMessage(eventId: string, event: DomainEvent): CapacityEventMessage {
  return {
    eventId,
    eventType: eventTypeOf(event),
    occurredAt: event.occurredAt.toISOString(),
    programId: event.aggregateId,
    data: dataOf(event),
  };
}

function eventTypeOf(event: DomainEvent): string {
  if (event instanceof ProgramOpened) return 'capacity.program-opened';
  if (event instanceof CapacityReserved) return 'capacity.reserved';
  if (event instanceof CapacityReleased) return 'capacity.released';
  if (event instanceof CreditLimitChanged) return 'capacity.credit-limit-changed';
  if (event instanceof ProgramStatusChanged) return 'capacity.program-status-changed';

  throw new InvariantViolationError(`${event.eventName} has no published event contract.`);
}

function dataOf(event: DomainEvent): Record<string, unknown> {
  if (event instanceof ProgramOpened) {
    return { creditLimit: event.creditLimit.toJSON() };
  }
  if (event instanceof CapacityReserved) {
    return {
      reservationId: event.reservationId.value,
      invoiceId: event.invoiceId.value,
      invoiceAmount: event.invoiceAmount.toJSON(),
      reservedAmount: event.reservedAmount.toJSON(),
      availableAfter: event.availableAfter.toJSON(),
    };
  }
  if (event instanceof CapacityReleased) {
    return {
      reservationId: event.reservationId.value,
      invoiceId: event.invoiceId.value,
      repaymentId: event.repaymentId.value,
      repaidAmount: event.repaidAmount.toJSON(),
      releasedAmount: event.releasedAmount.toJSON(),
      reservationFullyReleased: event.reservationFullyReleased,
      availableAfter: event.availableAfter.toJSON(),
    };
  }
  if (event instanceof CreditLimitChanged) {
    return {
      previousLimit: event.previousLimit.toJSON(),
      creditLimit: event.creditLimit.toJSON(),
      reservedAmount: event.reservedAmount.toJSON(),
      overLimit: event.overLimit,
    };
  }
  if (event instanceof ProgramStatusChanged) {
    return { previousStatus: event.previousStatus, status: event.status };
  }

  throw new InvariantViolationError(`${event.eventName} has no published event contract.`);
}
