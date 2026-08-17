import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId (UUIDv7)', () => {
  it('produces well-formed UUIDv7 strings', () => {
    for (let i = 0; i < 50; i++) {
      expect(newId()).toMatch(UUID_V7_PATTERN);
    }
  });

  it('is strictly monotonically increasing under a tight loop', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('sorts the same lexicographically as it was generated', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('encodes an increasing timestamp across a real time gap', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId();
    expect(second > first).toBe(true);
    // First 6 bytes (12 hex chars, ignoring the dash after 8) carry the ms timestamp.
    const firstTs = first.replace(/-/g, '').slice(0, 12);
    const secondTs = second.replace(/-/g, '').slice(0, 12);
    expect(secondTs >= firstTs).toBe(true);
  });
});
