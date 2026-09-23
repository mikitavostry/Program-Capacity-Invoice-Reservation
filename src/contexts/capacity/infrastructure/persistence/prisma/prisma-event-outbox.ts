import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../../../generated/prisma/client.js';
import type { DomainEvent } from '../../../../../shared/domain/domain-event.js';
import type { EventOutbox } from '../../../domain/ports/event-outbox.js';
import { toCapacityEventMessage } from '../../messaging/capacity-events.js';

export class PrismaEventOutbox implements EventOutbox {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async add(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Built now, so an event with no public contract fails the change, not the relay later.
    await this.tx.outboxEvent.createMany({
      data: events.map((event) => {
        const message = toCapacityEventMessage(randomUUID(), event);
        return {
          id: message.eventId,
          programId: message.programId,
          eventType: message.eventType,
          payload: message as unknown as Prisma.InputJsonValue,
          occurredAt: event.occurredAt,
        };
      }),
    });
  }
}
