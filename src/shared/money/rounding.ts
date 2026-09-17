import { DomainError } from '../domain/domain-error.js';

/**
 * How a division that does not come out exactly should resolve.
 *
 * `CEILING` rounds towards positive infinity and is what capacity reservations use. A
 * reserved amount is a risk exposure hold, so rounding must never be the reason a credit
 * limit is breached; holding a fraction of a minor unit too much is the safe direction to
 * be wrong in, and the release returns it intact.
 *
 * `HALF_UP` rounds to the nearest unit with ties going away from zero. It is the
 * conventional choice for a figure someone is actually paid — a different number, with a
 * different purpose, and therefore a different policy.
 */
export type RoundingMode = 'CEILING' | 'HALF_UP';

export class InvalidDivisorError extends DomainError {
  readonly code = 'INVALID_DIVISOR';

  constructor() {
    super('A rounding divisor must be a positive integer.');
  }
}

/**
 * Divides two integers under an explicit rounding policy, exactly.
 *
 * Everything stays in `bigint`, so no intermediate value passes through a float and there
 * is nothing for the rounding decision to be made on but the true remainder.
 */
export function divideWithRounding(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  if (divisor <= 0n) throw new InvalidDivisorError();

  const quotient = numerator / divisor;
  const remainder = numerator % divisor;

  if (remainder === 0n) return quotient;

  // bigint division truncates towards zero, so a negative quotient has already rounded up.
  if (mode === 'CEILING') {
    return remainder > 0n ? quotient + 1n : quotient;
  }

  const negative = remainder < 0n;
  const doubledRemainder = negative ? -remainder * 2n : remainder * 2n;

  if (doubledRemainder < divisor) return quotient;

  return negative ? quotient - 1n : quotient + 1n;
}
