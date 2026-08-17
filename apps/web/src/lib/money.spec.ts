import { describe, expect, it } from 'vitest';
import { formatMoneyMinor } from './money';

describe('formatMoneyMinor', () => {
  it('formats a genuine zero', () => {
    expect(formatMoneyMinor(0, 'USD')).toBe('$0.00');
  });

  it('formats a value under one major unit', () => {
    expect(formatMoneyMinor(5, 'USD')).toBe('$0.05');
    expect(formatMoneyMinor(50, 'USD')).toBe('$0.50');
    expect(formatMoneyMinor(99, 'USD')).toBe('$0.99');
  });

  it('formats an ordinary value with grouping', () => {
    expect(formatMoneyMinor(4_200_00, 'USD')).toBe('$4,200.00');
    expect(formatMoneyMinor(15_099, 'USD')).toBe('$150.99');
  });

  it('formats a large value without losing precision', () => {
    // $1,234,567.89 - large enough that a naive minorUnits / 100 float
    // division has historically produced 1234567.8899999999-style drift in
    // other codebases; the exact integer division/remainder here must not.
    expect(formatMoneyMinor(123_456_789, 'USD')).toBe('$1,234,567.89');
  });

  it('formats a negative/credit balance, including one under one major unit', () => {
    expect(formatMoneyMinor(-50, 'USD')).toBe('-$0.50');
    expect(formatMoneyMinor(-1, 'USD')).toBe('-$0.01');
    expect(formatMoneyMinor(-15_000, 'USD')).toBe('-$150.00');
    expect(formatMoneyMinor(-4_200_00, 'USD')).toBe('-$4,200.00');
  });

  it('never emits a bare -0', () => {
    expect(formatMoneyMinor(-1, 'USD')).not.toContain('-$0.00');
    expect(formatMoneyMinor(0, 'USD')).not.toContain('-');
  });

  it('respects a currency with a different fractional-digit count', () => {
    // JPY has no minor unit at all - Intl reports 0 fraction digits.
    expect(formatMoneyMinor(1_234, 'JPY')).toBe('¥1,234');
    expect(formatMoneyMinor(-1_234, 'JPY')).toBe('-¥1,234');
  });

  it('rejects a non-integer input rather than silently truncating it', () => {
    expect(() => formatMoneyMinor(10.5, 'USD')).toThrow(RangeError);
  });
});
