'use client';

import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@sms/ui';
import type { GradeLevel, RolloverOutcome, RolloverOutcomeResult } from '../../../../lib/api';
import { PersonNameCell } from '../person-name-cell';

const RESULT_LABELS: Record<RolloverOutcomeResult, string> = {
  promoted: 'Promoted',
  skipped_no_mapping: 'Skipped — no grade mapping',
  skipped_already_enrolled: 'Skipped — already enrolled',
};

const RESULT_BADGE_VARIANT: Record<RolloverOutcomeResult, 'neutral' | 'success' | 'warning'> = {
  promoted: 'success',
  skipped_no_mapping: 'warning',
  skipped_already_enrolled: 'neutral',
};

const SHOWN_LIMIT = 100;

export function RolloverOutcomesTable({
  outcomes,
  gradeLevelsById,
}: {
  outcomes: RolloverOutcome[];
  gradeLevelsById: Map<string, GradeLevel>;
}) {
  const shown = outcomes.slice(0, SHOWN_LIMIT);

  return (
    <div className="flex flex-col gap-2">
      {outcomes.length > shown.length ? (
        <p className="text-xs text-fg-subtle">
          Showing the first {shown.length} of {outcomes.length} students considered.
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Student</TableHead>
            <TableHead>From grade</TableHead>
            <TableHead>To grade</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((outcome) => (
            <TableRow key={outcome.fromEnrollmentId}>
              <TableCell>
                <PersonNameCell personId={outcome.personId} />
              </TableCell>
              <TableCell className="text-fg-muted">
                {gradeLevelsById.get(outcome.fromGradeLevelId)?.name ?? outcome.fromGradeLevelId}
              </TableCell>
              <TableCell className="text-fg-muted">
                {outcome.toGradeLevelId
                  ? (gradeLevelsById.get(outcome.toGradeLevelId)?.name ?? outcome.toGradeLevelId)
                  : '—'}
              </TableCell>
              <TableCell>
                <Badge variant={RESULT_BADGE_VARIANT[outcome.result]}>{RESULT_LABELS[outcome.result]}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
