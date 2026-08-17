'use client';

import * as React from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Loader2, Save } from 'lucide-react';
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  cn,
} from '@sms/ui';
import {
  enterScores,
  fetchAssignmentScores,
  fetchSectionGrades,
  type Assignment,
  type EnterScoreInput,
  type GradeCategory,
  type Score,
  type ScoreStatus,
  type SectionStudent,
  type StudentSectionGrade,
} from '../../../../lib/api';
import {
  SCORE_STATUS_ABBR,
  SCORE_STATUS_CELL_CLASS,
  SCORE_STATUS_LABELS,
  formatDateOnly,
  formatPercentage,
  letterBadgeVariant,
  sortStudents,
  studentDisplayName,
  studentInitials,
} from '../format';

export interface GradebookGridProps {
  sectionId: string;
  gradingPeriodId: string;
  students: SectionStudent[];
  categories: GradeCategory[];
  allAssignments: Assignment[];
  canWrite: boolean;
  locked: boolean;
}

interface CellEdit {
  /** Raw text as typed - kept as a string (not a number) so a half-typed value like "8." is never silently coerced away while editing. */
  points: string;
  status: ScoreStatus;
}

type EditsState = Record<string, Record<string, CellEdit>>;

function nonNegativeNumberOrNull(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function cellKey(assignmentId: string, personId: string): string {
  return `${assignmentId}:${personId}`;
}

/**
 * The grid itself: students down, assignments across, a running total on the
 * end. Every assignment column is its own save unit with its own
 * idempotency key (see `saveColumn` below) - exactly what the task brief
 * calls for ("Save is explicit and batched per assignment").
 */
export function GradebookGrid({
  sectionId,
  gradingPeriodId,
  students,
  categories,
  allAssignments,
  canWrite,
  locked,
}: GradebookGridProps) {
  const queryClient = useQueryClient();

  const categoriesById = React.useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const sortedStudents = React.useMemo(() => sortStudents(students), [students]);

  const assignments = React.useMemo(() => {
    const inPeriod = allAssignments.filter((a) => a.gradingPeriodId === gradingPeriodId);
    return [...inPeriod].sort((a, b) => {
      const catA = categoriesById.get(a.categoryId)?.sequence ?? 0;
      const catB = categoriesById.get(b.categoryId)?.sequence ?? 0;
      if (catA !== catB) return catA - catB;
      const dueA = a.dueOn ?? '';
      const dueB = b.dueOn ?? '';
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      return a.title.localeCompare(b.title);
    });
  }, [allAssignments, gradingPeriodId, categoriesById]);

  // Grouped runs of contiguous assignments sharing a category, for the
  // two-row header (category spanning row above, assignment detail row
  // below) - `assignments` is already sorted by category sequence so equal
  // categoryIds are always contiguous.
  const categoryGroups = React.useMemo(() => {
    const groups: { categoryId: string; categoryName: string; weight: number; count: number }[] = [];
    for (const assignment of assignments) {
      const last = groups[groups.length - 1];
      if (last && last.categoryId === assignment.categoryId) {
        last.count += 1;
        continue;
      }
      const category = categoriesById.get(assignment.categoryId);
      groups.push({
        categoryId: assignment.categoryId,
        categoryName: category?.name ?? 'Uncategorised',
        weight: category?.weight ?? 0,
        count: 1,
      });
    }
    return groups;
  }, [assignments, categoriesById]);

  const scoreQueries = useQueries({
    queries: assignments.map((assignment) => ({
      queryKey: ['gradebook', 'assignment', assignment.id, 'scores'],
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchAssignmentScores(assignment.id, signal),
    })),
  });

  const gradesQuery = useQuery({
    queryKey: ['gradebook', 'section', sectionId, 'grades', gradingPeriodId],
    queryFn: ({ signal }) => fetchSectionGrades(sectionId, gradingPeriodId, signal),
  });

  const scoresByAssignment = React.useMemo(() => {
    const map = new Map<string, Map<string, Score>>();
    assignments.forEach((assignment, index) => {
      const scores = scoreQueries[index]?.data ?? [];
      map.set(assignment.id, new Map(scores.map((s) => [s.personId, s])));
    });
    return map;
  }, [assignments, scoreQueries]);

  const gradesByPerson = React.useMemo(() => {
    const map = new Map<string, StudentSectionGrade>();
    for (const grade of gradesQuery.data ?? []) map.set(grade.personId, grade);
    return map;
  }, [gradesQuery.data]);

  const [edits, setEdits] = React.useState<EditsState>({});
  const [idempotencyKeys, setIdempotencyKeys] = React.useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = React.useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = React.useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = React.useState<Set<string>>(new Set());

  const inputRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());

  function resolvedCell(assignmentId: string, personId: string): { points: string; status: ScoreStatus; hasScore: boolean; dirty: boolean } {
    const edit = edits[assignmentId]?.[personId];
    if (edit) return { ...edit, hasScore: true, dirty: true };
    const baseline = scoresByAssignment.get(assignmentId)?.get(personId);
    if (baseline) {
      return {
        points: baseline.points === null ? '' : String(baseline.points),
        status: baseline.status,
        hasScore: true,
        dirty: false,
      };
    }
    return { points: '', status: 'graded', hasScore: false, dirty: false };
  }

  function setCell(assignmentId: string, personId: string, patch: Partial<CellEdit>) {
    setEdits((prev) => {
      const existing = resolvedCell(assignmentId, personId);
      const next: CellEdit = { points: existing.points, status: existing.status, ...patch };
      return {
        ...prev,
        [assignmentId]: { ...prev[assignmentId], [personId]: next },
      };
    });
  }

  function dirtyCountFor(assignmentId: string): number {
    return Object.keys(edits[assignmentId] ?? {}).length;
  }

  const totalDirtyCount = assignments.reduce((sum, a) => sum + dirtyCountFor(a.id), 0);

  async function saveColumn(assignment: Assignment) {
    const dirty = edits[assignment.id];
    if (!dirty || Object.keys(dirty).length === 0) return;

    // Any cell whose points failed to parse blocks the WHOLE column's save
    // rather than silently dropping it - a save that quietly skips one
    // student's entered score is worse than one that asks for a fix first.
    const invalidPersonIds = Object.entries(dirty)
      .filter(([, cell]) => nonNegativeNumberOrNull(cell.points) === undefined)
      .map(([personId]) => personId);
    if (invalidPersonIds.length > 0) {
      setSaveErrors((prev) => ({ ...prev, [assignment.id]: 'Fix the invalid score(s) highlighted below before saving.' }));
      return;
    }

    const key = idempotencyKeys[assignment.id] ?? crypto.randomUUID();
    setIdempotencyKeys((prev) => ({ ...prev, [assignment.id]: key }));
    setSavingIds((prev) => new Set(prev).add(assignment.id));
    setSaveErrors((prev) => {
      const next = { ...prev };
      delete next[assignment.id];
      return next;
    });

    try {
      const scores: EnterScoreInput[] = Object.entries(dirty).map(([personId, cell]) => ({
        personId,
        status: cell.status,
        points: nonNegativeNumberOrNull(cell.points) ?? null,
      }));
      await enterScores(assignment.id, { idempotencyKey: key, scores });

      setEdits((prev) => {
        const next = { ...prev };
        delete next[assignment.id];
        return next;
      });
      setIdempotencyKeys((prev) => {
        const next = { ...prev };
        delete next[assignment.id];
        return next;
      });
      setSavedFlash((prev) => new Set(prev).add(assignment.id));
      window.setTimeout(() => {
        setSavedFlash((prev) => {
          const next = new Set(prev);
          next.delete(assignment.id);
          return next;
        });
      }, 2000);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['gradebook', 'assignment', assignment.id, 'scores'] }),
        queryClient.invalidateQueries({ queryKey: ['gradebook', 'section', sectionId, 'grades', gradingPeriodId] }),
      ]);
    } catch (error) {
      // The idempotency key is deliberately NOT rotated on failure (see
      // EnterScoresInput's own comment) - a retry must replay the exact same
      // attempt, and the edits stay in state so nothing typed is lost.
      setSaveErrors((prev) => ({ ...prev, [assignment.id]: (error as Error).message }));
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(assignment.id);
        return next;
      });
    }
  }

  async function saveAll() {
    const dirtyAssignments = assignments.filter((a) => dirtyCountFor(a.id) > 0);
    await Promise.all(dirtyAssignments.map((a) => saveColumn(a)));
  }

  function focusCell(assignmentIndex: number, studentIndex: number) {
    const clampedA = Math.min(Math.max(assignmentIndex, 0), assignments.length - 1);
    const clampedS = Math.min(Math.max(studentIndex, 0), sortedStudents.length - 1);
    const assignment = assignments[clampedA];
    const student = sortedStudents[clampedS];
    if (!assignment || !student) return;
    const input = inputRefs.current.get(cellKey(assignment.id, student.personId));
    input?.focus();
    input?.select();
  }

  function handleCellKeyDown(event: React.KeyboardEvent<HTMLInputElement>, assignmentIndex: number, studentIndex: number) {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;

    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      focusCell(assignmentIndex, studentIndex + 1);
    } else if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      focusCell(assignmentIndex, studentIndex - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusCell(assignmentIndex, studentIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusCell(assignmentIndex, studentIndex - 1);
    } else if (event.key === 'ArrowRight' && atEnd) {
      event.preventDefault();
      focusCell(assignmentIndex + 1, studentIndex);
    } else if (event.key === 'ArrowLeft' && atStart) {
      event.preventDefault();
      focusCell(assignmentIndex - 1, studentIndex);
    }
  }

  function computeAverage(assignment: Assignment): { avgPct: number; gradedCount: number } | null {
    const scores = Array.from(scoresByAssignment.get(assignment.id)?.values() ?? []);
    const gradable = scores.filter((s) => s.status !== 'exempt' && s.points !== null);
    if (gradable.length === 0) return null;
    const avgPct =
      gradable.reduce((sum, s) => sum + ((s.points as number) / assignment.pointsPossible) * 100, 0) / gradable.length;
    return { avgPct, gradedCount: gradable.length };
  }

  const scoresLoading = scoreQueries.some((q) => q.isPending);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-auto rounded-card border border-border" style={{ maxHeight: 'calc(100dvh - 22rem)' }}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th
                rowSpan={2}
                className="sticky start-0 top-0 z-30 min-w-52 whitespace-nowrap border-b border-e border-border bg-surface-sunken px-3 py-2 text-start align-bottom text-xs font-medium text-fg-muted"
              >
                Student
              </th>
              {categoryGroups.map((group) => (
                <th
                  key={group.categoryId}
                  colSpan={group.count}
                  className="sticky top-0 z-20 h-9 whitespace-nowrap border-b border-border bg-surface-sunken px-2 text-start align-middle text-xs font-semibold text-fg"
                >
                  {group.categoryName}
                  <span className="ms-1.5 font-normal text-fg-subtle">{group.weight}%</span>
                </th>
              ))}
              <th
                rowSpan={2}
                className="sticky end-0 top-0 z-30 min-w-28 whitespace-nowrap border-b border-s border-border bg-surface-sunken px-3 py-2 text-end align-bottom text-xs font-medium text-fg-muted"
              >
                Total
              </th>
            </tr>
            <tr>
              {assignments.map((assignment) => {
                const average = computeAverage(assignment);
                const dirtyCount = dirtyCountFor(assignment.id);
                const saving = savingIds.has(assignment.id);
                const saveError = saveErrors[assignment.id];
                const justSaved = savedFlash.has(assignment.id);
                return (
                  <th
                    key={assignment.id}
                    className="sticky top-9 z-20 min-w-28 max-w-36 border-b border-border bg-surface-sunken px-2 py-2 align-top text-start font-normal"
                  >
                    <div className="flex flex-col gap-1">
                      <span className="truncate text-xs font-semibold text-fg" title={assignment.title}>
                        {assignment.title}
                      </span>
                      <span className="text-[11px] text-fg-subtle" data-tabular>
                        / {assignment.pointsPossible} pts
                        {assignment.dueOn ? ` · ${formatDateOnly(assignment.dueOn)}` : ''}
                      </span>
                      <span className="text-[11px] text-fg-subtle" data-tabular>
                        {average ? `Avg ${formatPercentage(average.avgPct)} (${average.gradedCount}/${sortedStudents.length})` : 'No scores yet'}
                      </span>
                      {canWrite && !locked ? (
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant={dirtyCount > 0 ? 'primary' : 'secondary'}
                            className="h-6 px-2 text-[11px]"
                            disabled={dirtyCount === 0 || saving}
                            onClick={() => void saveColumn(assignment)}
                          >
                            {saving ? (
                              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                            ) : justSaved ? (
                              <Check className="size-3" />
                            ) : (
                              <Save className="size-3" />
                            )}
                            {dirtyCount > 0 ? `Save (${dirtyCount})` : 'Saved'}
                          </Button>
                        </div>
                      ) : null}
                      {saveError ? (
                        <span className="flex items-start gap-1 text-[11px] text-danger">
                          <AlertCircle className="mt-0.5 size-3 shrink-0" />
                          {saveError}
                        </span>
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedStudents.map((student, studentIndex) => {
              const grade = gradesByPerson.get(student.personId);
              return (
                <tr key={student.personId} className="group">
                  <td className="sticky start-0 z-10 whitespace-nowrap border-b border-e border-border bg-surface px-3 py-1.5 group-hover:bg-surface-sunken/60">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar className="size-7 shrink-0">
                        <AvatarFallback className="text-[11px]">{studentInitials(student)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate text-sm font-medium text-fg">{studentDisplayName(student)}</span>
                    </div>
                  </td>
                  {assignments.map((assignment, assignmentIndex) => (
                    <GradeCell
                      key={assignment.id}
                      assignment={assignment}
                      cell={resolvedCell(assignment.id, student.personId)}
                      disabled={!canWrite || locked}
                      loading={scoresLoading}
                      inputRef={(el) => {
                        const key = cellKey(assignment.id, student.personId);
                        if (el) inputRefs.current.set(key, el);
                        else inputRefs.current.delete(key);
                      }}
                      onPointsChange={(value) => setCell(assignment.id, student.personId, { points: value })}
                      onStatusChange={(status) => setCell(assignment.id, student.personId, { status })}
                      onKeyDown={(event) => handleCellKeyDown(event, assignmentIndex, studentIndex)}
                    />
                  ))}
                  <td className="sticky end-0 z-10 whitespace-nowrap border-b border-s border-border bg-surface px-3 py-1.5 text-end group-hover:bg-surface-sunken/60">
                    {grade ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-sm font-medium text-fg" data-tabular>
                          {formatPercentage(grade.percentage)}
                        </span>
                        {grade.letter ? <Badge variant={letterBadgeVariant(grade.letter)}>{grade.letter}</Badge> : null}
                      </div>
                    ) : (
                      <span className="text-sm text-fg-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canWrite && !locked && totalDirtyCount > 0 ? (
        <div className="sticky bottom-4 z-20 flex items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-3 shadow-raised">
          <span className="text-xs text-fg-muted">
            {totalDirtyCount} unsaved score{totalDirtyCount === 1 ? '' : 's'} across{' '}
            {assignments.filter((a) => dirtyCountFor(a.id) > 0).length} assignment(s)
          </span>
          <Button onClick={() => void saveAll()} disabled={assignments.some((a) => savingIds.has(a.id))}>
            <Save className="size-4" />
            Save all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface GradeCellProps {
  assignment: Assignment;
  cell: { points: string; status: ScoreStatus; hasScore: boolean; dirty: boolean };
  disabled: boolean;
  loading: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onPointsChange: (value: string) => void;
  onStatusChange: (status: ScoreStatus) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * One (student, assignment) cell. Three states must never look alike (see
 * this task's brief): empty (no score row exists at all - muted placeholder,
 * no fill), a real numeric score (tabular digits, no fill), and a non-graded
 * status (missing/exempt/late/incomplete - a distinct tinted background PLUS
 * an abbreviation badge, never colour alone). An unsaved edit gets its own
 * signal (a primary-coloured start border) independent of all three, so
 * "this cell changed" is never confused with "this cell is missing/exempt".
 */
function GradeCell({ assignment, cell, disabled, loading, inputRef, onPointsChange, onStatusChange, onKeyDown }: GradeCellProps) {
  const invalid = cell.points.trim() !== '' && nonNegativeNumberOrNull(cell.points) === undefined;
  const nonGradedClass = cell.status !== 'graded' ? SCORE_STATUS_CELL_CLASS[cell.status] : '';

  return (
    <td
      className={cn(
        'border-b border-border p-0 align-middle',
        nonGradedClass,
        cell.dirty && 'border-s-2 border-s-primary',
      )}
    >
      {loading ? (
        <div className="flex h-12 items-center justify-center px-2">
          <Skeleton className="h-4 w-10" />
        </div>
      ) : (
        <div className="flex h-12 items-center gap-1 px-1.5">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            value={cell.points}
            placeholder={cell.hasScore ? '0' : '–'}
            aria-label={`${assignment.title} score`}
            aria-invalid={invalid || undefined}
            onChange={(event) => onPointsChange(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              'h-7 w-12 min-w-0 rounded-control border border-transparent bg-transparent px-1 text-end text-sm tabular-nums text-fg',
              'placeholder:text-fg-subtle',
              'focus-visible:border-border-strong focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              'disabled:cursor-not-allowed disabled:opacity-70',
              invalid && 'border-danger text-danger',
            )}
          />
          <Select value={cell.status} onValueChange={(value) => onStatusChange(value as ScoreStatus)} disabled={disabled}>
            <SelectTrigger
              aria-label={`${assignment.title} status`}
              className={cn(
                'h-6 w-11 min-w-0 gap-0.5 rounded-control border-border px-1 text-[9px] font-semibold uppercase text-fg-muted',
                cell.status !== 'graded' && 'text-fg',
              )}
            >
              <span className="truncate">{cell.status === 'graded' ? '·' : SCORE_STATUS_ABBR[cell.status]}</span>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SCORE_STATUS_LABELS) as ScoreStatus[]).map((status) => (
                <SelectItem key={status} value={status} className="text-xs">
                  {SCORE_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </td>
  );
}
