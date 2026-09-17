/**
 * Something that happened in the domain, named in the past tense.
 *
 * Aggregates record events; the application layer drains and publishes them once the
 * transaction has committed, so a change that was rolled back never announces itself.
 */
export interface DomainEvent {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}
