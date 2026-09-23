import { DomainError } from '../domain/domain-error.js';

/**
 * `CEILING` for reservations: a hold may exceed the converted amount by a fraction of a minor
 * unit but never fall short of it, so rounding can never be what breaches a limit.
 * `FLOOR` for partial releases: never free more than the share actually repaid. The final
 * repayment frees exactly what is left, so the two cancel out.
 */
export type RoundingMode = 'CEILING' | 'FLOOR';

export class InvalidDivisorError extends DomainError {
  readonly code = 'INVALID_DIVISOR';

  constructor() {
    super('A rounding divisor must be a positive integer.');
  }
}

export function divideWithRounding(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  if (divisor <= 0n) throw new InvalidDivisorError();

  const quotient = numerator / divisor;
  const remainder = numerator % divisor;

  if (remainder === 0n) return quotient;

  // bigint division truncates towards zero.
  if (mode === 'CEILING') return remainder > 0n ? quotient + 1n : quotient;
  return remainder < 0n ? quotient - 1n : quotient;
}
