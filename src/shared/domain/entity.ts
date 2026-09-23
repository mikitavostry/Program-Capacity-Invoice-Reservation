import { Identifier } from './identifier.js';

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
