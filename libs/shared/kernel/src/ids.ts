import { randomBytes } from 'node:crypto';

/**
 * Nominal (branded) typing helper. `Brand<string, 'TenantId'>` is a `string`
 * at runtime but a distinct type at compile time, so a `CampusId` can never
 * be passed where a `TenantId` is expected even though both are plain UUID
 * strings underneath.
 */
declare const brandSymbol: unique symbol;
export type Brand<T, K extends string> = T & { readonly [brandSymbol]: K };

export type TenantId = Brand<string, 'TenantId'>;
export type CampusId = Brand<string, 'CampusId'>;
export type PersonId = Brand<string, 'PersonId'>;
export type AcademicYearId = Brand<string, 'AcademicYearId'>;
export type UserId = Brand<string, 'UserId'>;

// ---------------------------------------------------------------------------
// UUIDv7 (RFC 9562) - timestamp-ordered, 48-bit unix-ms timestamp followed by
// version/variant bits and 74 bits of randomness. No dependency: this is a
// small, self-contained implementation.
//
// Monotonicity: RFC 9562 offers several methods for keeping IDs strictly
// increasing when several are minted within the same millisecond. This uses
// "Method 1: Monotonic Random" - when the wall clock has not advanced past
// the previous call, the random tail is incremented by one instead of being
// re-rolled, guaranteeing uuid[n] > uuid[n-1] as plain strings even under a
// tight generation loop.
// ---------------------------------------------------------------------------

const RAND_BITS = 74n; // 12 bits (rand_a) + 62 bits (rand_b)
const RAND_MASK = (1n << RAND_BITS) - 1n;

let lastTimestampMs = -1;
let lastRandBits = 0n;

function rollRandBits(): bigint {
  // 10 random bytes (80 bits) masked down to the 74 bits we need.
  const buf = randomBytes(10);
  let value = 0n;
  for (const byte of buf) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & RAND_MASK;
}

function toHexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/**
 * Generates a new UUIDv7 string. Lexicographic (and therefore string/byte)
 * ordering of the output matches generation order.
 */
export function newId(): string {
  let timestampMs = Date.now();

  if (timestampMs <= lastTimestampMs) {
    timestampMs = lastTimestampMs;
    lastRandBits = (lastRandBits + 1n) & RAND_MASK;
    if (lastRandBits === 0n) {
      // Extremely unlikely (2^74 ids in one ms), but keeps ordering correct
      // even in that case by borrowing a millisecond from the future.
      timestampMs += 1;
      lastRandBits = rollRandBits();
    }
  } else {
    lastRandBits = rollRandBits();
  }
  lastTimestampMs = timestampMs;

  const randA = (lastRandBits >> 62n) & 0xfffn; // top 12 bits
  const randB = lastRandBits & 0x3fffffffffffffn; // bottom 62 bits

  const bytes = new Uint8Array(16);

  // 48-bit big-endian unix millisecond timestamp.
  const ts = BigInt(timestampMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version 7 in the top nibble of byte 6, then 12 bits of rand_a.
  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn);
  bytes[7] = Number(randA & 0xffn);

  // Variant (10) in the top 2 bits of byte 8, then 62 bits of rand_b.
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  bytes[9] = Number((randB >> 48n) & 0xffn);
  bytes[10] = Number((randB >> 40n) & 0xffn);
  bytes[11] = Number((randB >> 32n) & 0xffn);
  bytes[12] = Number((randB >> 24n) & 0xffn);
  bytes[13] = Number((randB >> 16n) & 0xffn);
  bytes[14] = Number((randB >> 8n) & 0xffn);
  bytes[15] = Number(randB & 0xffn);

  const hex = Array.from(bytes, toHexByte).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
