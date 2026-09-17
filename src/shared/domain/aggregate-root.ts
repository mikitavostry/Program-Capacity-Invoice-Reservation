import type { DomainEvent } from './domain-event.js';
import { Entity } from './entity.js';
import type { Identifier } from './identifier.js';

/**
 * The entry point to an aggregate: the only object code outside the boundary may hold a
 * reference to, and the place the aggregate's invariants are enforced.
 *
 * This deliberately does not extend the `AggregateRoot` from `@nestjs/cqrs`. Events are
 * recorded here and published by the application layer, which keeps the domain free of a
 * framework dependency and — more usefully — leaves publication under the transaction's
 * control rather than the aggregate's.
 */
export abstract class AggregateRoot<TId extends Identifier> extends Entity<TId> {
  #events: DomainEvent[] = [];

  protected raise(event: DomainEvent): void {
    this.#events.push(event);
  }

  get domainEvents(): readonly DomainEvent[] {
    return [...this.#events];
  }

  /**
   * Hands over the recorded events and forgets them, so a second drain returns nothing and
   * no event can be published twice.
   */
  pullDomainEvents(): DomainEvent[] {
    const drained = this.#events;
    this.#events = [];
    return drained;
  }
}
