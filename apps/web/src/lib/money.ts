/**
 * Formats an integer minor-units amount (e.g. `4_200_00` -> "$4,200.00")
 * without ever going through floating-point division. `billing`'s own money
 * rule (see `libs/domain/billing/migrations/1400_billing.sql`'s header and
 * `docs/decisions.md`) is "integer minor units only, no floating point,
 * anywhere" - this is the display-side half of that: the split into a whole
 * major-unit part and a minor-unit remainder is done with `Math.trunc` and
 * subtraction (exact for the safe-integer amounts real invoices produce),
 * never `minorUnits / 100` fed into `Intl`/`toFixed` and rounded back.
 *
 * `Intl.NumberFormat` still does the actual locale/currency-symbol/grouping
 * work (that part genuinely needs it) - but it is only ever asked to format
 * a real INTEGER (the major-unit part), never the minor-units value divided
 * down. The fractional digits it renders are substituted in afterwards from
 * the exact integer remainder.
 *
 * A currency's own fractional-digit count (2 for USD, 0 for JPY, 3 for BHD,
 * ...) is read from `Intl` itself rather than assumed to always be 2.
 *
 * Negative values (a net credit balance - see `InvoiceBalance.balanceMinor`'s
 * own doc comment) are handled without ever formatting `-0`: when the whole
 * amount is negative but its major-unit part is exactly 0 (e.g. -50 minor
 * units = "-$0.50"), the sign/placement template is borrowed from formatting
 * a real `-1` instead of the ambiguous `-0`, whose currency rendering is not
 * consistent across JS engines.
 */
export function formatMoneyMinor(minorUnits: number, currency: string, locale = 'en-US'): string {
  if (!Number.isInteger(minorUnits)) {
    throw new RangeError(`formatMoneyMinor: minorUnits must be an integer, got ${minorUnits}`);
  }

  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  // `style: 'currency'` always resolves a concrete maximumFractionDigits (2
  // for USD, 0 for JPY, 3 for BHD, ...) - the `| undefined` in Intl's own
  // type only covers other styles/roundingPriority combinations that don't
  // apply here. The `?? 2` is an unreachable-in-practice type-level fallback,
  // not a guess this function actually expects to use.
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const divisor = 10 ** fractionDigits;

  const isNegative = minorUnits < 0;
  const absMinor = Math.abs(minorUnits);
  const majorPart = Math.trunc(absMinor / divisor); // integer division
  const minorRemainder = absMinor - majorPart * divisor; // exact remainder, never a modulo on a float
  const fractionStr = minorRemainder.toString().padStart(fractionDigits, '0');

  // Real, non-zero negative integer whenever the amount is negative, so the
  // sign is never carried by an ambiguous -0 - see this file's own comment.
  const templateValue = isNegative ? (majorPart === 0 ? -1 : -majorPart) : majorPart;
  const parts = formatter.formatToParts(templateValue);

  return parts
    .map((part) => {
      if (part.type === 'fraction') return fractionStr;
      // Only reachable when templateValue was the placeholder -1 (majorPart
      // is genuinely 0) - swap its single "1" digit back out for "0".
      if (isNegative && majorPart === 0 && part.type === 'integer') return '0';
      return part.value;
    })
    .join('');
}
