import { Identifier } from './identifier.js';

/**
 * An entity is defined by its identity rather than its attributes: two instances are the
 * same entity when their ids match, however much the rest of their state differs.
 */
export abstract class Entity<TId extends Identifier> {
  readonly id: TId;

  protected constructor(id: TId) {
    this.id = id;
  }

  equals(other: unknown): boolean {
    if (other === this) return true;
    if (!(other instanceof Entity)) return false;
    if (other.constructor !== this.constructor) return false;

    return this.id.equals((other as Entity<Identifier>).id);
  }
}
