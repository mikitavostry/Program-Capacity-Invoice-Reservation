import { describe, expect, it } from 'vitest';
import { InvalidDivisorError, divideWithRounding } from './rounding.js';

describe('divideWithRounding', () => {
  it('returns an exact quotient untouched, whatever the mode', () => {
    expect(divideWithRounding(6n, 2n, 'CEILING')).toBe(3n);
    expect(divideWithRounding(6n, 2n, 'HALF_UP')).toBe(3n);
    expect(divideWithRounding(-6n, 2n, 'CEILING')).toBe(-3n);
    expect(divideWithRounding(-6n, 2n, 'HALF_UP')).toBe(-3n);
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

  describe('HALF_UP', () => {
    it.each([
      [5n, 2n, 3n], // 2.5 -> 3, tie away from zero
      [4n, 3n, 1n], // 1.333 -> 1
      [5n, 3n, 2n], // 1.667 -> 2
      [1n, 1000n, 0n], // well below half, stays put
    ])('rounds %s/%s to %s', (numerator, divisor, expected) => {
      expect(divideWithRounding(numerator, divisor, 'HALF_UP')).toBe(expected);
    });

    it('breaks negative ties away from zero', () => {
      expect(divideWithRounding(-5n, 2n, 'HALF_UP')).toBe(-3n);
      expect(divideWithRounding(-3n, 2n, 'HALF_UP')).toBe(-2n);
      expect(divideWithRounding(-4n, 3n, 'HALF_UP')).toBe(-1n);
    });
  });

  it('refuses a divisor that is not positive', () => {
    expect(() => divideWithRounding(1n, 0n, 'CEILING')).toThrow(InvalidDivisorError);
    expect(() => divideWithRounding(1n, -2n, 'HALF_UP')).toThrow(InvalidDivisorError);
  });

  it('stays exact at magnitudes that would lose precision as a double', () => {
    const beyondSafeInteger = 9_007_199_254_740_993n; // 2^53 + 1

    expect(divideWithRounding(beyondSafeInteger * 3n, 3n, 'CEILING')).toBe(beyondSafeInteger);
  });
});
