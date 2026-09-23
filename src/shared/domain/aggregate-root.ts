import type { DomainEvent } from './domain-event.js';
import { Entity } from './entity.js';
import type { Identifier } from './identifier.js';

/**
 * Records domain events for the application layer to persist with the change. Not Nest's
 * `AggregateRoot`, to keep the domain free of framework code.
 */
export abstract class AggregateRoot<TId extends Identifier> extends Entity<TId> {
  #events: DomainEvent[] = [];

  protected raise(event: DomainEvent): void {
    this.#events.push(event);
  }

  get domainEvents(): readonly DomainEvent[] {
    return [...this.#events];
  }

  /** Returns the recorded events and clears them, so none is handled twice. */
  pullDomainEvents(): DomainEvent[] {
    const drained = this.#events;
    this.#events = [];
    return drained;
  }
}
