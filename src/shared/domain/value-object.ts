/**
 * Defined by its attributes. Equality is written out per type rather than derived
 * reflectively, which would mishandle `bigint`, `Date` and derived fields.
 */
export abstract class ValueObject {
  abstract equals(other: unknown): boolean;
}
