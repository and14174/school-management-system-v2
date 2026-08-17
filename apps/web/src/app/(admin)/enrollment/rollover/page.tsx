'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, CircleCheck, PlayCircle, ShieldOff, WifiOff } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  EmptyState,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
} from '@sms/ui';
import { fetchGradeLevels, fetchScope, rollOverYear, type RolloverResult } from '../../../../lib/api';
import { ForbiddenError } from '../../../../lib/http';
import { usePermissions } from '../../../../lib/permissions';
import { ConfirmRolloverDialog } from './confirm-dialog';
import { RolloverOutcomesTable } from './outcomes-table';

const NO_PROMOTION = '__none__';

function signatureFor(fromId: string, toId: string, map: Record<string, string>): string {
  const sortedEntries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ fromId, toId, map: sortedEntries });
}

export default function RolloverPage() {
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions();

  const scopeQuery = useQuery({ queryKey: ['tenancy', 'scope'], queryFn: ({ signal }) => fetchScope(undefined, signal) });
  const gradeLevelsQuery = useQuery({
    queryKey: ['academic', 'grade-levels'],
    queryFn: ({ signal }) => fetchGradeLevels(signal),
  });

  const academicYears = React.useMemo(
    () => [...(scopeQuery.data?.academicYears ?? [])].sort((a, b) => a.startsOn.localeCompare(b.startsOn)),
    [scopeQuery.data],
  );
  const gradeLevels = React.useMemo(
    () => [...(gradeLevelsQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence),
    [gradeLevelsQuery.data],
  );
  const gradeLevelsById = React.useMemo(() => new Map(gradeLevels.map((g) => [g.id, g])), [gradeLevels]);

  const [fromAcademicYearId, setFromAcademicYearId] = React.useState('');
  const [toAcademicYearId, setToAcademicYearId] = React.useState('');
  const [promotionMap, setPromotionMap] = React.useState<Record<string, string>>({});
  const promotionMapInitialised = React.useRef(false);

  // Default academic years: the current one -> the next by start date, if
  // both exist - a sensible starting point the user can still override.
  React.useEffect(() => {
    if (academicYears.length === 0) return;
    if (!fromAcademicYearId) {
      const current = scopeQuery.data?.current.academicYearId;
      setFromAcademicYearId(current && academicYears.some((y) => y.id === current) ? current : academicYears[0]!.id);
    }
  }, [academicYears, fromAcademicYearId, scopeQuery.data]);

  React.useEffect(() => {
    if (!toAcademicYearId && fromAcademicYearId && academicYears.length > 0) {
      const index = academicYears.findIndex((y) => y.id === fromAcademicYearId);
      const next = academicYears[index + 1];
      if (next) setToAcademicYearId(next.id);
    }
  }, [academicYears, fromAcademicYearId, toAcademicYearId]);

  // Default promotion map: each grade level to the next one by sequence.
  // The highest-sequence grade level has no default (nothing to promote
  // into) - left unmapped, which the API records as `skipped_no_mapping`,
  // exactly right for a graduating class.
  React.useEffect(() => {
    if (promotionMapInitialised.current || gradeLevels.length === 0) return;
    const defaults: Record<string, string> = {};
    for (let i = 0; i < gradeLevels.length - 1; i += 1) {
      defaults[gradeLevels[i]!.id] = gradeLevels[i + 1]!.id;
    }
    setPromotionMap(defaults);
    promotionMapInitialised.current = true;
  }, [gradeLevels]);

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [dryRunResult, setDryRunResult] = React.useState<RolloverResult | null>(null);
  const [dryRunSignature, setDryRunSignature] = React.useState<string | null>(null);
  const [realResult, setRealResult] = React.useState<RolloverResult | null>(null);

  const currentSignature = signatureFor(fromAcademicYearId, toAcademicYearId, promotionMap);

  const dryRunMutation = useMutation({
    mutationFn: () =>
      rollOverYear({ fromAcademicYearId, toAcademicYearId, promotionMap, dryRun: true }),
    onSuccess: (result) => {
      setDryRunResult(result);
      setDryRunSignature(currentSignature);
      setRealResult(null);
    },
    onError: (error: Error) => {
      toast.error('Could not run the dry run', { description: error.message });
    },
  });

  const realRunMutation = useMutation({
    mutationFn: () =>
      rollOverYear({ fromAcademicYearId, toAcademicYearId, promotionMap, dryRun: false }),
    onSuccess: (result) => {
      setRealResult(result);
      setConfirmOpen(false);
      toast.success('Rollover complete', {
        description: `${result.counts.promotedCount} students promoted.`,
      });
    },
    onError: (error: Error) => {
      toast.error('Could not run the rollover', { description: error.message });
    },
  });

  if (!permissionsLoading && !permissionsError && !can('enrollment.rollover:run')) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School · Enrollment" title="Year rollover" />
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to do this"
          description="Running a year rollover requires the enrollment.rollover:run permission. Ask an administrator if you believe this is a mistake."
          className="min-h-[24rem] justify-center"
        />
      </div>
    );
  }

  if (scopeQuery.isError || gradeLevelsQuery.isError) {
    const error = scopeQuery.error ?? gradeLevelsQuery.error;
    if (error instanceof ForbiddenError) {
      return (
        <EmptyState
          icon={<ShieldOff className="size-5" />}
          title="You don't have permission to view this"
          description="Setting up a rollover requires read access to academic years, campuses and grade levels."
          className="min-h-[24rem] justify-center"
        />
      );
    }
    return (
      <EmptyState
        icon={<WifiOff className="size-5" />}
        title="Couldn't load rollover setup data"
        description={error?.message}
        className="min-h-[24rem] justify-center"
      />
    );
  }

  if (scopeQuery.isPending || gradeLevelsQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="School · Enrollment" title="Year rollover" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const fromYear = academicYears.find((y) => y.id === fromAcademicYearId);
  const toYear = academicYears.find((y) => y.id === toAcademicYearId);
  const canRunReal = Boolean(dryRunResult) && dryRunSignature === currentSignature && !realRunMutation.isPending;
  const inputsValid = Boolean(fromAcademicYearId) && Boolean(toAcademicYearId) && fromAcademicYearId !== toAcademicYearId;

  function updateMapping(fromId: string, toId: string) {
    setPromotionMap((prev) => {
      const next = { ...prev };
      if (toId === NO_PROMOTION) delete next[fromId];
      else next[fromId] = toId;
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="School · Enrollment"
        title="Year rollover"
        description="Promote every currently-enrolled student into next year's enrolment, grade level by grade level. The largest single write this product makes - a dry run is required first."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rollover-from-year">From academic year</Label>
          <Select value={fromAcademicYearId} onValueChange={setFromAcademicYearId}>
            <SelectTrigger id="rollover-from-year" aria-label="From academic year">
              <SelectValue placeholder="Choose a year" />
            </SelectTrigger>
            <SelectContent>
              {academicYears.map((year) => (
                <SelectItem key={year.id} value={year.id}>
                  {year.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rollover-to-year">To academic year</Label>
          <Select value={toAcademicYearId} onValueChange={setToAcademicYearId}>
            <SelectTrigger id="rollover-to-year" aria-label="To academic year">
              <SelectValue placeholder="Choose a year" />
            </SelectTrigger>
            <SelectContent>
              {academicYears.map((year) => (
                <SelectItem key={year.id} value={year.id}>
                  {year.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!inputsValid && fromAcademicYearId && toAcademicYearId ? (
        <Alert variant="warning">
          <AlertTitle>Choose two different academic years</AlertTitle>
          <AlertDescription>The from and to year cannot be the same.</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">Grade level promotion</h3>
        <p className="text-xs text-fg-subtle">
          Defaults to the next grade level in sequence. A grade with no mapping is skipped (recorded as no
          mapping) - leave the highest grade unmapped for a graduating class.
        </p>
        <div className="flex flex-col gap-2 rounded-card border border-border p-3">
          {gradeLevels.map((gradeLevel) => (
            <div key={gradeLevel.id} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-sm text-fg">{gradeLevel.name}</span>
              <ArrowRight className="size-3.5 shrink-0 text-fg-subtle" />
              <Select
                value={promotionMap[gradeLevel.id] ?? NO_PROMOTION}
                onValueChange={(value) => updateMapping(gradeLevel.id, value)}
              >
                <SelectTrigger aria-label={`Promote from ${gradeLevel.name}`} className="flex-1">
                  <SelectValue placeholder="No promotion" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROMOTION}>No promotion (exits this year)</SelectItem>
                  {gradeLevels
                    .filter((candidate) => candidate.id !== gradeLevel.id)
                    .map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end border-t border-border pt-5">
        <Button
          variant="secondary"
          onClick={() => dryRunMutation.mutate()}
          disabled={!inputsValid}
          loading={dryRunMutation.isPending}
        >
          <PlayCircle className="size-4" />
          Run dry run
        </Button>
      </div>

      {dryRunResult && dryRunSignature === currentSignature ? (
        <div className="flex flex-col gap-4 rounded-card border border-border p-4">
          <div className="flex items-center gap-2">
            <CircleCheck className="size-4 text-success" />
            <h3 className="text-sm font-semibold text-fg">Dry run results</h3>
            <span className="text-xs text-fg-subtle">Nothing was written yet.</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Considered" value={dryRunResult.counts.consideredCount} />
            <StatTile label="Will be promoted" value={dryRunResult.counts.promotedCount} />
            <StatTile label="Will be skipped" value={dryRunResult.counts.skippedCount} />
          </div>
          <RolloverOutcomesTable outcomes={dryRunResult.outcomes} gradeLevelsById={gradeLevelsById} />

          {!realResult ? (
            <div className="flex justify-end border-t border-border pt-4">
              <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!canRunReal}>
                Run rollover for real
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {dryRunResult && dryRunSignature !== currentSignature ? (
        <Alert variant="info" icon={<AlertTriangle className="mt-0.5 size-4 shrink-0 text-info" />}>
          <AlertTitle>Inputs changed since the last dry run</AlertTitle>
          <AlertDescription>Run the dry run again to preview this exact combination before running it for real.</AlertDescription>
        </Alert>
      ) : null}

      {realResult ? (
        <div className="flex flex-col gap-4 rounded-card border border-success/30 bg-success-soft p-4">
          <div className="flex items-center gap-2">
            <CircleCheck className="size-4 text-success" />
            <h3 className="text-sm font-semibold text-fg">Rollover complete</h3>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Considered" value={realResult.counts.consideredCount} />
            <StatTile label="Promoted" value={realResult.counts.promotedCount} />
            <StatTile label="Skipped" value={realResult.counts.skippedCount} />
          </div>
          <p className="text-sm text-fg-muted">
            This rollover was written as a single bulk operation
            {realResult.bulkOperationId ? (
              <>
                {' '}
                (id <span className="font-mono text-xs">{realResult.bulkOperationId}</span>)
              </>
            ) : null}
            , so the whole batch is reversible as one unit if needed. There is no self-service undo on this screen
            yet - give this id to an administrator, the same way an import job&apos;s bulk operation is reverted
            from Settings → Import.
          </p>
        </div>
      ) : null}

      {fromYear && toYear ? (
        <ConfirmRolloverDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          fromYearName={fromYear.name}
          toYearName={toYear.name}
          promotedCount={dryRunResult?.counts.promotedCount ?? 0}
          consideredCount={dryRunResult?.counts.consideredCount ?? 0}
          onConfirm={() => realRunMutation.mutate()}
          isRunning={realRunMutation.isPending}
        />
      ) : null}
    </div>
  );
}
