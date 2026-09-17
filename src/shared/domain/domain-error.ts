/**
 * Base class for errors that express a violated business rule.
 *
 * Every domain error carries a stable, machine-readable `code`. Turning that code into a
 * transport-level status is the presentation layer's job, which is why nothing in the
 * domain mentions HTTP.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
