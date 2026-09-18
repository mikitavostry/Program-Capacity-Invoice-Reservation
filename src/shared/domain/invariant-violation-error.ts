import { DomainError } from './domain-error.js';

/**
 * State that the model says cannot exist, found to exist.
 *
 * Unlike a business-rule rejection such as insufficient capacity, this is never the
 * caller's fault and never something to retry: it means stored data was corrupted, or code
 * bypassed an aggregate to change it. It should fail loudly rather than be worked around.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
