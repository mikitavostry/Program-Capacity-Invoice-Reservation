/*
 * Exact conversion between decimal strings and scaled integers. Amounts and rates cross the
 * boundary as strings because a JSON number has already been through a binary float.
 */

export type DecimalParseResult =
  { readonly ok: true; readonly scaled: bigint } | { readonly ok: false; readonly reason: string };

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses `raw` into an integer scaled by `10 ** scale`. Excess precision is rejected, not
 * rounded, so the service never holds a different amount from the one the caller sent.
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

export function formatScaledDecimal(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const sign = negative ? '-' : '';

  if (scale === 0) return `${sign}${absolute}`;

  const divisor = 10n ** BigInt(scale);
  const fraction = (absolute % divisor).toString().padStart(scale, '0');

  return `${sign}${absolute / divisor}.${fraction}`;
}
