/**
 * A value object is defined entirely by its attributes: two instances holding the same
 * values are interchangeable, and neither has an identity of its own.
 *
 * Equality is declared abstract rather than derived reflectively from whatever properties
 * an instance happens to carry. Reflection compares the fields the type has today, which is
 * not the same question as what the concept considers equal, and it quietly mishandles
 * `bigint`, `Date` and cached derived fields.
 */
export abstract class ValueObject {
  abstract equals(other: unknown): boolean;
}
