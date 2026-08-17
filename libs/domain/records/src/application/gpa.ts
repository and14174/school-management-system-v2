/**
 * The ONE place GPA arithmetic happens in this module - both
 * `ReportCardService` (a report card's own `gpa`) and `TranscriptService`
 * (`calculateGpa`, `getTranscript`'s `cumulativeGpa`) call this, so there is
 * exactly one weighting rule to reason about.
 *
 * Weighted by `credits`, computed from each row's ALREADY-RESOLVED
 * `gpaPoints` only - see the `1200` migration header: a transcript that
 * re-derives GPA by re-resolving a letter against today's grade scale is a
 * legal problem, not an implementation detail. A row with `gpaPoints: null`
 * (nothing graded yet) or `credits <= 0` (ungraded/non-credit-bearing)
 * contributes neither numerator nor denominator - it is excluded, not
 * treated as a zero, so a handful of in-progress courses do not drag an
 * otherwise-complete GPA toward failing.
 */
export interface GpaWeight {
  readonly gpaPoints: number | null;
  readonly credits: number;
}

/** `null` when no row qualifies (nothing gradeable, or every qualifying row has zero credits) - never `NaN` or a fabricated `0`. Rounded to two decimal places. */
export function weightedGpa(rows: readonly GpaWeight[]): number | null {
  let pointsSum = 0;
  let creditsSum = 0;

  for (const row of rows) {
    if (row.gpaPoints === null || row.credits <= 0) {
      continue;
    }
    pointsSum += row.gpaPoints * row.credits;
    creditsSum += row.credits;
  }

  if (creditsSum <= 0) {
    return null;
  }
  return Math.round((pointsSum / creditsSum) * 100) / 100;
}
