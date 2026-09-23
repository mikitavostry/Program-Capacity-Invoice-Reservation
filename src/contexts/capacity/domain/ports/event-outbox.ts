import type { DomainEvent } from '../../../../shared/domain/domain-event.js';

export interface EventOutbox {
  add(events: readonly DomainEvent[]): Promise<void>;
}
