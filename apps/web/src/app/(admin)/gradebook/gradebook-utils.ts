import type { Assignment, GradingPeriod } from '../../../lib/api';
import { formatShortDateOnly } from './format';

export interface GradingPeriodOption {
  gradingPeriodId: string;
  /** The real name when `academic.term:read` resolved it; otherwise a label derived from the assignments' own due dates - see `lib/api.ts`'s top-of-file comment on why a Teacher often can't resolve the real name. */
  label: string;
  assignmentCount: number;
  /** Used only to pick a sensible default selection - the most recently-due period, not necessarily "current" by calendar date. */
  sortKey: number;
}

/** Every distinct grading period represented among `assignments`, resolved against `gradingPeriods` (real names, when the caller could read them) with a graceful fallback label built from the assignments themselves. */
export function buildGradingPeriodOptions(
  assignments: Assignment[],
  gradingPeriods: GradingPeriod[],
): GradingPeriodOption[] {
  const gradingPeriodsById = new Map(gradingPeriods.map((period) => [period.id, period]));
  const byId = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const list = byId.get(assignment.gradingPeriodId);
    if (list) {
      list.push(assignment);
    } else {
      byId.set(assignment.gradingPeriodId, [assignment]);
    }
  }

  const options: GradingPeriodOption[] = [];
  for (const [gradingPeriodId, periodAssignments] of byId) {
    const resolved = gradingPeriodsById.get(gradingPeriodId);
    const dueDates = periodAssignments.map((a) => a.dueOn).filter((d): d is string => Boolean(d)).sort();
    const earliest = dueDates[0];
    const latest = dueDates[dueDates.length - 1];
    const fallbackLabel =
      earliest && latest
        ? earliest === latest
          ? `Grading period (${formatShortDateOnly(earliest)})`
          : `Grading period (${formatShortDateOnly(earliest)} – ${formatShortDateOnly(latest)})`
        : `Grading period ${gradingPeriodId.slice(0, 8)}`;

    options.push({
      gradingPeriodId,
      label: resolved ? resolved.name : fallbackLabel,
      assignmentCount: periodAssignments.length,
      sortKey: resolved ? resolved.sequence : (latest ? Date.parse(latest) : 0),
    });
  }

  return options.sort((a, b) => a.sortKey - b.sortKey);
}

/** The most recently-due grading period - the sensible default to land on. */
export function pickDefaultGradingPeriodId(options: GradingPeriodOption[]): string | null {
  if (options.length === 0) return null;
  return options[options.length - 1]?.gradingPeriodId ?? null;
}
