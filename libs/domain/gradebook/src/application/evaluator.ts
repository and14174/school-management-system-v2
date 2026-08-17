import type { AssignmentContribution, CalculationRules, CategoryBreakdown, GradeBand, ScoreStatus } from '../domain/types.js';

/**
 * The ONE evaluator `calculateSectionGrades` (and, later, the workflow/
 * automation engines the module brief calls out) runs every weighted/
 * drop-lowest/rounding computation through. It is a pure function of DATA
 * (`CalculationRules`, produced from a `gradebook.calculation_rule_set_version`
 * row - see the `1000` migration header) and never branches on a "scheme"
 * string - per-school variation is expressed entirely in the `rules` JSON a
 * school publishes, not in code paths here.
 */

export interface AssignmentScoreInput {
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly pointsPossible: number;
  /** `null` for a status where points are not meaningful (`missing`/`exempt` with nothing entered). */
  readonly pointsEarned: number | null;
  readonly status: ScoreStatus;
}

export interface CategoryScoreInput {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly assignments: readonly AssignmentScoreInput[];
}

export interface EvaluationResult {
  readonly percentage: number | null;
  readonly breakdown: readonly CategoryBreakdown[];
}

function roundTo(value: number, decimals: number, mode: CalculationRules['rounding']['mode']): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;

  let rounded: number;
  switch (mode) {
    case 'floor':
      rounded = Math.floor(scaled);
      break;
    case 'ceil':
      rounded = Math.ceil(scaled);
      break;
    case 'half-even': {
      const floor = Math.floor(scaled);
      const diff = scaled - floor;
      if (diff < 0.5) {
        rounded = floor;
      } else if (diff > 0.5) {
        rounded = floor + 1;
      } else {
        rounded = floor % 2 === 0 ? floor : floor + 1;
      }
      break;
    }
    case 'half-up':
    default:
      rounded = Math.round(scaled);
      break;
  }
  return rounded / factor;
}

/**
 * Evaluates one category: excludes `exempt` assignments entirely, treats
 * `missing` as zero points earned (still counted in the denominator), drops
 * the lowest `dropLowest` gradeable assignments by their OWN percentage
 * (capped so at least one gradeable assignment always survives), and sums
 * the rest.
 */
function evaluateCategory(categoryId: string, categoryName: string, weight: number, dropLowest: number, assignments: readonly AssignmentScoreInput[]): CategoryBreakdown {
  const gradeable = assignments.filter((a) => a.status !== 'exempt');
  const effectiveDrop = Math.min(Math.max(dropLowest, 0), Math.max(gradeable.length - 1, 0));

  const withOwnPercentage = gradeable.map((a) => {
    const earned = a.status === 'missing' ? 0 : (a.pointsEarned ?? 0);
    const ownPercentage = a.pointsPossible > 0 ? (earned / a.pointsPossible) * 100 : 0;
    return { assignment: a, earned, ownPercentage };
  });

  const droppedIds = new Set(
    [...withOwnPercentage]
      .sort((a, b) => a.ownPercentage - b.ownPercentage)
      .slice(0, effectiveDrop)
      .map((entry) => entry.assignment.assignmentId),
  );

  let earnedPoints = 0;
  let possiblePoints = 0;
  const contributions: AssignmentContribution[] = [];

  for (const a of assignments) {
    const dropped = a.status !== 'exempt' && droppedIds.has(a.assignmentId);
    contributions.push({
      assignmentId: a.assignmentId,
      assignmentTitle: a.assignmentTitle,
      pointsEarned: a.status === 'exempt' ? null : a.status === 'missing' ? 0 : (a.pointsEarned ?? 0),
      pointsPossible: a.pointsPossible,
      status: a.status,
      dropped,
    });

    if (a.status === 'exempt' || dropped) {
      continue;
    }
    const earned = a.status === 'missing' ? 0 : (a.pointsEarned ?? 0);
    earnedPoints += earned;
    possiblePoints += a.pointsPossible;
  }

  const percentage = possiblePoints > 0 ? (earnedPoints / possiblePoints) * 100 : null;

  return { categoryId, categoryName, weight, earnedPoints, possiblePoints, percentage, contributions };
}

/**
 * Evaluates one student's overall percentage for a section/grading period
 * from `categories` (the section's live `gradebook.category` rows, each
 * carrying its scored assignments) and `rules` (a
 * `calculation_rule_set_version.rules` snapshot). A category with no
 * matching entry in `rules.categories` (matched by name, case-insensitive -
 * see the `1000` migration header) is excluded from the weighted total
 * entirely (weight 0), and still reported in the breakdown so a teacher can
 * see why it didn't count.
 *
 * The overall percentage is the weight-normalised average of every category
 * that produced a percentage (categories with nothing gradeable yet
 * contribute neither numerator nor denominator, so a partially-graded period
 * still resolves to a sensible number rather than being dragged toward
 * zero). `null` when nothing at all has been graded.
 */
export function evaluateStudentGrade(rules: CalculationRules, categories: readonly CategoryScoreInput[]): EvaluationResult {
  const rulesByName = new Map(rules.categories.map((c) => [c.name.trim().toLowerCase(), c]));

  const breakdown = categories.map((category) => {
    const rule = rulesByName.get(category.categoryName.trim().toLowerCase());
    const weight = rule?.weight ?? 0;
    const dropLowest = rule?.dropLowest ?? 0;
    return evaluateCategory(category.categoryId, category.categoryName, weight, dropLowest, category.assignments);
  });

  let weightedSum = 0;
  let weightTotal = 0;
  for (const entry of breakdown) {
    if (entry.percentage === null || entry.weight <= 0) {
      continue;
    }
    weightedSum += entry.percentage * entry.weight;
    weightTotal += entry.weight;
  }

  const rawPercentage = weightTotal > 0 ? weightedSum / weightTotal : null;
  const percentage = rawPercentage === null ? null : roundTo(rawPercentage, rules.rounding.decimals, rules.rounding.mode);

  return { percentage, breakdown };
}

/**
 * Resolves the letter (and GPA points, if the band carries one) for
 * `percentage` against `bands` - the highest band whose `min` is `<=
 * percentage`, regardless of the order `bands` was stored in. `null` when no
 * band's `min` is low enough (a scale that does not start at 0, or a
 * percentage below every band).
 */
export function resolveLetter(bands: readonly GradeBand[], percentage: number): { readonly label: string; readonly gpaPoints: number | null } | null {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  for (const band of sorted) {
    if (percentage >= band.min) {
      return { label: band.label, gpaPoints: band.gpaPoints ?? null };
    }
  }
  return null;
}
