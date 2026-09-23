import { DomainError } from './domain-error.js';
import { ValueObject } from './value-object.js';

export class InvalidIdentifierError extends DomainError {
  readonly code = 'INVALID_IDENTIFIER';

  constructor(typeName: string, reason: string) {
    super(`${typeName} is invalid: ${reason}.`);
  }
}

export abstract class Identifier extends ValueObject {
  readonly value: string;

  protected constructor(value: string) {
    super();

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidIdentifierError(new.target.name, 'it must be a non-empty string');
    }

    this.value = value.trim();
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Identifier &&
      other.constructor === this.constructor &&
      other.value === this.value
    );
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
