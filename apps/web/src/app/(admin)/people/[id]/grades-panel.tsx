'use client';

import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { GraduationCap, Lock, WifiOff } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@sms/ui';
import {
  fetchGradingPeriods,
  fetchScope,
  fetchSection,
  fetchStudentGrades,
  fetchTerms,
  type PersonDetail,
  type Section,
  type StudentSectionGrade,
} from '../../../../lib/api';
import { usePermissions } from '../../../../lib/permissions';
import { formatPercentage, letterBadgeVariant } from '../../gradebook/format';

const TODAY = new Date().toISOString().slice(0, 10);

function pickCurrentOrLatest<T extends { startsOn: string; endsOn: string; sequence: number }>(
  items: T[],
): T | undefined {
  if (items.length === 0) return undefined;
  const current = items.find((item) => item.startsOn <= TODAY && TODAY <= item.endsOn);
  if (current) return current;
  return [...items].sort((a, b) => b.sequence - a.sequence)[0];
}

/**
 * A student's grades across every section they're enrolled in for one
 * grading period - what `GET /gradebook/students/:personId/grades` returns.
 * Needs a `gradingPeriodId` to call at all (the API takes no "give me
 * everything" mode - see the contract's own doc comment: "their whole
 * report card for the period, not a single number"), so this panel builds a
 * term -> grading period picker from `academic.term:read` first. That
 * permission is gated separately from `academic.gradebook:read` - see
 * `lib/api.ts`'s comment on why a section-scoped Teacher usually lacks it.
 * This screen (`/people/:id`) is itself gated `people.person:read`, which the
 * Teacher role also lacks (confirmed against the seeded roles), so in
 * practice only an administrator/registrar - who DOES hold `academic.term:read`
 * tenant-wide - ever reaches this panel; the explanatory alert below exists
 * for correctness, not because it's expected to fire often.
 */
export function GradesPanel({ person }: { person: PersonDetail }) {
  const { can } = usePermissions();
  const canReadGradebook = can('academic.gradebook:read');
  const canReadTerms = can('academic.term:read');

  const [termId, setTermId] = React.useState<string | null>(null);
  const [gradingPeriodId, setGradingPeriodId] = React.useState<string | null>(null);

  const scopeQuery = useQuery({
    queryKey: ['tenancy', 'scope'],
    queryFn: ({ signal }) => fetchScope(undefined, signal),
    enabled: canReadGradebook && canReadTerms,
  });

  const academicYearId = scopeQuery.data?.current.academicYearId ?? undefined;

  const termsQuery = useQuery({
    queryKey: ['academic', 'terms', academicYearId ?? 'all'],
    queryFn: ({ signal }) => fetchTerms(academicYearId, signal),
    enabled: canReadGradebook && canReadTerms && Boolean(scopeQuery.data),
  });

  const terms = React.useMemo(() => [...(termsQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence), [termsQuery.data]);

  React.useEffect(() => {
    if (termId !== null) return;
    const pick = pickCurrentOrLatest(terms);
    if (pick) setTermId(pick.id);
  }, [terms, termId]);

  const gradingPeriodsQuery = useQuery({
    queryKey: ['academic', 'term', termId, 'grading-periods'],
    queryFn: ({ signal }) => fetchGradingPeriods(termId as string, signal),
    enabled: canReadGradebook && canReadTerms && Boolean(termId),
  });

  const gradingPeriods = React.useMemo(
    () => [...(gradingPeriodsQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence),
    [gradingPeriodsQuery.data],
  );

  React.useEffect(() => {
    setGradingPeriodId(null);
  }, [termId]);

  React.useEffect(() => {
    if (gradingPeriodId !== null) return;
    const pick = pickCurrentOrLatest(gradingPeriods);
    if (pick) setGradingPeriodId(pick.id);
  }, [gradingPeriods, gradingPeriodId]);

  const gradesQuery = useQuery({
    queryKey: ['gradebook', 'student', person.id, 'grades', gradingPeriodId],
    queryFn: ({ signal }) => fetchStudentGrades(person.id, gradingPeriodId as string, signal),
    enabled: canReadGradebook && Boolean(gradingPeriodId),
  });

  const sectionQueries = useQueries({
    queries: (gradesQuery.data ?? []).map((grade) => ({
      queryKey: ['academic', 'section', grade.sectionId],
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchSection(grade.sectionId, signal),
    })),
  });

  if (!canReadGradebook) {
    return (
      <Alert variant="warning" icon={<Lock className="mt-0.5 size-4 shrink-0 text-warning" />}>
        <AlertTitle>You don&apos;t have permission to view this</AlertTitle>
        <AlertDescription>Viewing grades requires the academic.gradebook:read permission.</AlertDescription>
      </Alert>
    );
  }

  if (!canReadTerms) {
    return (
      <Alert variant="warning" icon={<Lock className="mt-0.5 size-4 shrink-0 text-warning" />}>
        <AlertTitle>You don&apos;t have permission to view this</AlertTitle>
        <AlertDescription>
          Choosing a grading period to view requires the academic.term:read permission.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="size-4 text-fg-subtle" />
          Grades
        </CardTitle>
        <div className="flex items-center gap-2">
          <Select value={termId ?? undefined} onValueChange={setTermId}>
            <SelectTrigger className="w-36" aria-label="Term">
              <SelectValue placeholder="Term" />
            </SelectTrigger>
            <SelectContent>
              {terms.map((term) => (
                <SelectItem key={term.id} value={term.id}>
                  {term.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={gradingPeriodId ?? undefined} onValueChange={setGradingPeriodId} disabled={gradingPeriods.length === 0}>
            <SelectTrigger className="w-48" aria-label="Grading period">
              <SelectValue placeholder="Grading period" />
            </SelectTrigger>
            <SelectContent>
              {gradingPeriods.map((period) => (
                <SelectItem key={period.id} value={period.id}>
                  {period.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {termsQuery.isPending || (termId && gradingPeriodsQuery.isPending) ? (
          <Skeleton className="h-10 w-full" />
        ) : terms.length === 0 ? (
          <p className="text-sm text-fg-muted">No terms have been set up yet.</p>
        ) : gradingPeriods.length === 0 ? (
          <p className="text-sm text-fg-muted">This term has no grading periods yet.</p>
        ) : gradesQuery.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : gradesQuery.isError ? (
          <EmptyState
            icon={<WifiOff className="size-5" />}
            title="Couldn't load grades"
            description={gradesQuery.error.message}
          />
        ) : (gradesQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">No sections have assignments in this grading period.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {(gradesQuery.data ?? []).map((grade, index) => (
              <SectionGradeCard
                key={`${grade.sectionId}:${grade.gradingPeriodId}`}
                grade={grade}
                section={sectionQueries[index]?.data}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionGradeCard({ grade, section }: { grade: StudentSectionGrade; section: Section | undefined }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">
          {section ? `${section.code} · ${section.name}` : grade.sectionId}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg" data-tabular>
            {formatPercentage(grade.percentage)}
          </span>
          {grade.letter ? <Badge variant={letterBadgeVariant(grade.letter)}>{grade.letter}</Badge> : null}
          {grade.gpaPoints !== null ? (
            <span className="text-xs text-fg-subtle" data-tabular>
              {grade.gpaPoints.toFixed(1)} GPA
            </span>
          ) : null}
        </div>
      </div>

      {grade.breakdown.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing graded yet in this section for this period.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {grade.breakdown.map((category) => (
            <details key={category.categoryId} className="group rounded-control border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="font-medium text-fg">
                  {category.categoryName} <span className="font-normal text-fg-subtle">({category.weight}% weight)</span>
                </span>
                <span className="flex items-center gap-2 text-fg-muted" data-tabular>
                  {category.earnedPoints}/{category.possiblePoints} pts · {formatPercentage(category.percentage)}
                </span>
              </summary>
              <div className="flex flex-col divide-y divide-border border-t border-border">
                {category.contributions.map((contribution) => (
                  <div
                    key={contribution.assignmentId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className={contribution.dropped ? 'text-fg-subtle line-through' : 'text-fg'}>
                      {contribution.assignmentTitle}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {contribution.dropped ? <Badge variant="neutral">Dropped</Badge> : null}
                      {contribution.status !== 'graded' ? (
                        <Badge variant="neutral">{contribution.status}</Badge>
                      ) : null}
                      <span className="text-fg-muted" data-tabular>
                        {contribution.pointsEarned ?? '—'}/{contribution.pointsPossible}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
