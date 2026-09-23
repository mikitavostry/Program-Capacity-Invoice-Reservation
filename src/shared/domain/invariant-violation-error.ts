import { DomainError } from './domain-error.js';

/**
 * State the model says cannot exist: corrupt data or a bug, never the caller's fault. Not
 * mapped to an HTTP status, so it surfaces as a logged 500.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
