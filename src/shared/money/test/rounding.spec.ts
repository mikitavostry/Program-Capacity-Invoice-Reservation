import { describe, expect, it } from 'vitest';
import { InvalidDivisorError, divideWithRounding } from '../rounding.js';

describe('divideWithRounding', () => {
  it('returns an exact quotient untouched, whatever the mode', () => {
    expect(divideWithRounding(6n, 2n, 'CEILING')).toBe(3n);
    expect(divideWithRounding(6n, 2n, 'FLOOR')).toBe(3n);
    expect(divideWithRounding(-6n, 2n, 'CEILING')).toBe(-3n);
    expect(divideWithRounding(-6n, 2n, 'FLOOR')).toBe(-3n);
  });

  describe('CEILING', () => {
    it.each([
      [7n, 2n, 4n], // 3.5 -> 4
      [1n, 3n, 1n], // 0.333 -> 1
      [1n, 1000n, 1n], // the smallest positive remainder still rounds up
    ])('rounds %s/%s up to %s', (numerator, divisor, expected) => {
      expect(divideWithRounding(numerator, divisor, 'CEILING')).toBe(expected);
    });

    it('rounds towards positive infinity for negatives, not away from zero', () => {
      expect(divideWithRounding(-7n, 2n, 'CEILING')).toBe(-3n); // -3.5 -> -3
      expect(divideWithRounding(-1n, 3n, 'CEILING')).toBe(0n); // -0.333 -> 0
    });
  });

  describe('FLOOR', () => {
    it.each([
      [7n, 2n, 3n], // 3.5 -> 3
      [2n, 3n, 0n], // 0.667 -> 0
      [999n, 1000n, 0n], // just short of a whole unit still rounds down
    ])('rounds %s/%s down to %s', (numerator, divisor, expected) => {
      expect(divideWithRounding(numerator, divisor, 'FLOOR')).toBe(expected);
    });

    it('rounds towards negative infinity for negatives, not towards zero', () => {
      expect(divideWithRounding(-7n, 2n, 'FLOOR')).toBe(-4n); // -3.5 -> -4
      expect(divideWithRounding(-1n, 3n, 'FLOOR')).toBe(-1n); // -0.333 -> -1
    });
  });

  it('refuses a divisor that is not positive', () => {
    expect(() => divideWithRounding(1n, 0n, 'CEILING')).toThrow(InvalidDivisorError);
    expect(() => divideWithRounding(1n, -2n, 'FLOOR')).toThrow(InvalidDivisorError);
  });

  it('stays exact at magnitudes that would lose precision as a double', () => {
    const beyondSafeInteger = 9_007_199_254_740_993n; // 2^53 + 1

    expect(divideWithRounding(beyondSafeInteger * 3n, 3n, 'CEILING')).toBe(beyondSafeInteger);
  });
});
