import { describe, expect, it } from 'vitest';
import {
  clampInterval,
  compareDateOnly,
  formatDateOnly,
  intervalContains,
  intervalsOverlap,
  parseDateOnly,
  todayDateOnly,
  type DateOnly,
  type Interval,
} from './temporal.js';

const d = (s: string): DateOnly => parseDateOnly(s);
const iv = (from: string, to: string | null): Interval => ({ validFrom: d(from), validTo: to ? d(to) : null });

describe('parseDateOnly / formatDateOnly', () => {
  it('accepts a well-formed calendar date', () => {
    expect(parseDateOnly('2024-03-01')).toBe('2024-03-01');
  });

  it('rejects malformed strings', () => {
    expect(() => parseDateOnly('2024-3-1')).toThrow();
    expect(() => parseDateOnly('not-a-date')).toThrow();
    expect(() => parseDateOnly('2024-03-01T00:00:00Z')).toThrow();
  });

  it('rejects dates that do not exist on the calendar', () => {
    expect(() => parseDateOnly('2023-02-29')).toThrow(); // not a leap year
    expect(() => parseDateOnly('2024-13-01')).toThrow();
    expect(() => parseDateOnly('2024-02-30')).toThrow();
  });

  it('accepts a real leap day', () => {
    expect(parseDateOnly('2024-02-29')).toBe('2024-02-29');
  });

  it('formatDateOnly round-trips through parseDateOnly', () => {
    const formatted = formatDateOnly(new Date(2024, 5, 15)); // June 15 2024, local time
    expect(formatted).toBe('2024-06-15');
    expect(parseDateOnly(formatted)).toBe(formatted);
  });

  it('todayDateOnly returns a parseable DateOnly', () => {
    expect(() => parseDateOnly(todayDateOnly())).not.toThrow();
  });
});

describe('compareDateOnly', () => {
  it('orders chronologically', () => {
    expect(compareDateOnly(d('2024-01-01'), d('2024-01-02'))).toBe(-1);
    expect(compareDateOnly(d('2024-01-02'), d('2024-01-01'))).toBe(1);
    expect(compareDateOnly(d('2024-01-01'), d('2024-01-01'))).toBe(0);
  });
});

describe('intervalsOverlap', () => {
  it('two disjoint closed intervals do not overlap', () => {
    expect(intervalsOverlap(iv('2024-01-01', '2024-01-10'), iv('2024-02-01', '2024-02-10'))).toBe(false);
  });

  it('two intervals sharing an inner range overlap', () => {
    expect(intervalsOverlap(iv('2024-01-01', '2024-01-31'), iv('2024-01-15', '2024-02-15'))).toBe(true);
  });

  it('touching intervals (end of one == start of the other) DO overlap - both are inclusive', () => {
    expect(intervalsOverlap(iv('2024-01-01', '2024-01-10'), iv('2024-01-10', '2024-01-20'))).toBe(true);
  });

  it('adjacent but non-touching intervals (end + 1 day == start) do not overlap', () => {
    expect(intervalsOverlap(iv('2024-01-01', '2024-01-10'), iv('2024-01-11', '2024-01-20'))).toBe(false);
  });

  it('a single-day interval overlaps an interval containing that day', () => {
    expect(intervalsOverlap(iv('2024-01-05', '2024-01-05'), iv('2024-01-01', '2024-01-31'))).toBe(true);
  });

  it('two identical single-day intervals overlap', () => {
    expect(intervalsOverlap(iv('2024-01-05', '2024-01-05'), iv('2024-01-05', '2024-01-05'))).toBe(true);
  });

  it('a single-day interval adjacent to another single-day interval does not overlap', () => {
    expect(intervalsOverlap(iv('2024-01-05', '2024-01-05'), iv('2024-01-06', '2024-01-06'))).toBe(false);
  });

  it('an open-ended interval overlaps anything starting after it begins', () => {
    expect(intervalsOverlap(iv('2020-01-01', null), iv('2030-01-01', '2030-06-01'))).toBe(true);
  });

  it('an open-ended interval does not overlap something entirely before it starts', () => {
    expect(intervalsOverlap(iv('2020-01-01', null), iv('2010-01-01', '2010-06-01'))).toBe(false);
  });

  it('two open-ended intervals overlap once both have started', () => {
    expect(intervalsOverlap(iv('2020-01-01', null), iv('2021-01-01', null))).toBe(true);
  });

  it('overlap is symmetric', () => {
    const a = iv('2024-01-01', '2024-06-01');
    const b = iv('2024-05-01', null);
    expect(intervalsOverlap(a, b)).toBe(intervalsOverlap(b, a));
  });
});

describe('intervalContains', () => {
  it('contains dates within a closed interval, inclusive of both ends', () => {
    const interval = iv('2024-01-01', '2024-01-31');
    expect(intervalContains(interval, d('2024-01-01'))).toBe(true);
    expect(intervalContains(interval, d('2024-01-31'))).toBe(true);
    expect(intervalContains(interval, d('2024-01-15'))).toBe(true);
  });

  it('excludes dates outside a closed interval', () => {
    const interval = iv('2024-01-01', '2024-01-31');
    expect(intervalContains(interval, d('2023-12-31'))).toBe(false);
    expect(intervalContains(interval, d('2024-02-01'))).toBe(false);
  });

  it('an open-ended interval contains any date on or after validFrom', () => {
    const interval = iv('2024-01-01', null);
    expect(intervalContains(interval, d('2024-01-01'))).toBe(true);
    expect(intervalContains(interval, d('2099-01-01'))).toBe(true);
    expect(intervalContains(interval, d('2023-12-31'))).toBe(false);
  });

  it('a single-day interval contains only that day', () => {
    const interval = iv('2024-01-05', '2024-01-05');
    expect(intervalContains(interval, d('2024-01-05'))).toBe(true);
    expect(intervalContains(interval, d('2024-01-04'))).toBe(false);
    expect(intervalContains(interval, d('2024-01-06'))).toBe(false);
  });
});

describe('clampInterval', () => {
  it('clamps a wider interval down to bounds', () => {
    expect(clampInterval(iv('2020-01-01', '2029-12-31'), iv('2024-01-01', '2024-12-31'))).toEqual(
      iv('2024-01-01', '2024-12-31'),
    );
  });

  it('clamps an open-ended interval to closed bounds', () => {
    expect(clampInterval(iv('2020-01-01', null), iv('2024-01-01', '2024-12-31'))).toEqual(
      iv('2024-01-01', '2024-12-31'),
    );
  });

  it('leaves an interval fully inside the bounds untouched', () => {
    expect(clampInterval(iv('2024-03-01', '2024-06-01'), iv('2024-01-01', '2024-12-31'))).toEqual(
      iv('2024-03-01', '2024-06-01'),
    );
  });

  it('two open-ended intervals clamp to an open-ended result', () => {
    expect(clampInterval(iv('2020-01-01', null), iv('2024-01-01', null))).toEqual(iv('2024-01-01', null));
  });

  it('returns null when the interval and bounds do not overlap', () => {
    expect(clampInterval(iv('2020-01-01', '2020-12-31'), iv('2024-01-01', '2024-12-31'))).toBeNull();
  });

  it('returns a single-day interval when they touch at exactly one day', () => {
    expect(clampInterval(iv('2020-01-01', '2024-01-01'), iv('2024-01-01', '2024-12-31'))).toEqual(
      iv('2024-01-01', '2024-01-01'),
    );
  });
});
