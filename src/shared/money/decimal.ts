/**
 * Exact conversion between decimal strings and scaled integers.
 *
 * Amounts and exchange rates cross the system boundary as strings rather than JSON numbers
 * on purpose: by the time a value like `0.1` has been through an IEEE-754 double it has
 * already lost the precision this module exists to preserve.
 */

export type DecimalParseResult =
  { readonly ok: true; readonly scaled: bigint } | { readonly ok: false; readonly reason: string };

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses `raw` into an integer scaled by `10 ** scale`.
 *
 * Excess precision is rejected rather than rounded away. Silently truncating the input
 * would leave the service and the caller disagreeing about what was actually requested,
 * and that disagreement would only surface much later, in a total that does not add up.
 */
export function parseScaledDecimal(raw: string, scale: number): DecimalParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'it must be a string' };
  }

  const match = DECIMAL_PATTERN.exec(raw.trim());
  if (match === null) {
    return {
      ok: false,
      reason: 'it must be a decimal number such as "1234.56"',
    };
  }

  const [, sign, whole, fraction = ''] = match;

  if (fraction.length > scale) {
    return {
      ok: false,
      reason:
        scale === 0
          ? 'it must be a whole number'
          : `it must have at most ${scale} decimal place${scale === 1 ? '' : 's'}`,
    };
  }

  return {
    ok: true,
    scaled: BigInt(`${sign}${whole}${fraction.padEnd(scale, '0')}`),
  };
}

/**
 * Renders an integer scaled by `10 ** scale` back as a decimal string, keeping every
 * position the scale allows so the output width is stable.
 */
export function formatScaledDecimal(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const sign = negative ? '-' : '';

  if (scale === 0) return `${sign}${absolute}`;

  const divisor = 10n ** BigInt(scale);
  const fraction = (absolute % divisor).toString().padStart(scale, '0');

  return `${sign}${absolute / divisor}.${fraction}`;
}
