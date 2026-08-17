'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleCheck, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Badge, Button, Input, Label, Textarea, cn } from '@sms/ui';
import {
  AttendanceLockedError,
  markSession,
  requestAttendanceCorrection,
  type AttendanceCategory,
  type AttendanceCode,
  type MarkInput,
  type SessionRoster,
} from '../../../../lib/api';
import { ATTENDANCE_CATEGORY_BADGE_VARIANT, ATTENDANCE_CATEGORY_LABELS, formatDateOnly } from '../format';

interface EntryState {
  personId: string;
  givenName: string;
  familyName: string;
  existingRecordId: string | null;
  /** The code this student had when the roster loaded - used only to detect a genuine edit for the locked-correction flow below, never sent to the server. */
  originalCodeId: string | null;
  codeId: string;
  minutesLate: string;
  note: string;
}

export interface MarkingFormProps {
  sectionMeetingId: string;
  date: string;
  roster: SessionRoster;
  codes: AttendanceCode[];
  canWrite: boolean;
}

const SELECTED_CODE_CLASS: Record<AttendanceCategory, string> = {
  present: 'border-success/50 bg-success-soft text-success',
  absent: 'border-danger/50 bg-danger-soft text-danger',
  late: 'border-warning/50 bg-warning-soft text-warning',
  excused: 'border-info/50 bg-info-soft text-info',
};

function pickDefaultCode(codes: AttendanceCode[]): AttendanceCode | undefined {
  return codes.find((code) => code.isDefault) ?? codes.find((code) => code.category === 'present') ?? codes[0];
}

function buildInitialEntries(roster: SessionRoster, codes: AttendanceCode[]): EntryState[] {
  const defaultCode = pickDefaultCode(codes);
  return [...roster.entries]
    .sort((a, b) => `${a.familyName} ${a.givenName}`.localeCompare(`${b.familyName} ${b.givenName}`))
    .map((entry) => ({
      personId: entry.personId,
      givenName: entry.givenName,
      familyName: entry.familyName,
      existingRecordId: entry.existingRecordId,
      originalCodeId: entry.codeId,
      // Default everyone to the tenant's `isDefault` code (Present) so the
      // teacher only has to touch the exceptions - that is how a register is
      // actually taken. A student already marked keeps their existing code.
      codeId: entry.codeId ?? defaultCode?.id ?? '',
      minutesLate: entry.minutesLate != null ? String(entry.minutesLate) : '',
      note: entry.note ?? '',
    }));
}

/**
 * The stateful register form. Mounted fresh (via the page's `key={sectionMeetingId:date}`)
 * for every distinct session-load, which is exactly what makes
 * `useState(() => crypto.randomUUID())` below correct: it runs once when
 * this session-load starts and is reused across every retry until a
 * submission actually succeeds - per this task's idempotency requirement,
 * a fresh key per click would turn a flaky-network double-tap into two real
 * submissions. A NEW key is generated only after a successful submit,
 * because resubmitting the SAME key a second time would silently REPLAY the
 * original result rather than saving new edits (see markSession's
 * server-side idempotency-ledger behaviour) - this form treats "the
 * submission succeeded" as the end of one attempt and the start of the next,
 * not as a reason to keep reusing a now-spent key.
 */
export function MarkingForm({ sectionMeetingId, date, roster, codes, canWrite }: MarkingFormProps) {
  const queryClient = useQueryClient();
  const defaultCode = React.useMemo(() => pickDefaultCode(codes), [codes]);
  const codesById = React.useMemo(() => new Map(codes.map((code) => [code.id, code])), [codes]);
  const sortedCodes = React.useMemo(() => [...codes].sort((a, b) => a.sequence - b.sequence), [codes]);

  const [entries, setEntries] = React.useState<EntryState[]>(() => buildInitialEntries(roster, codes));
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());
  const [lockedMessage, setLockedMessage] = React.useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = React.useState('');
  const [correctionStatus, setCorrectionStatus] = React.useState<Record<string, 'pending' | 'done' | 'error'>>({});

  const alreadyMarked = roster.entries.some((entry) => entry.existingRecordId);

  function updateEntry(personId: string, patch: Partial<EntryState>) {
    setEntries((prev) => prev.map((entry) => (entry.personId === personId ? { ...entry, ...patch } : entry)));
  }

  function selectCode(personId: string, codeId: string) {
    const code = codesById.get(codeId);
    setEntries((prev) =>
      prev.map((entry) =>
        entry.personId === personId
          ? { ...entry, codeId, minutesLate: code?.category === 'late' ? entry.minutesLate : '' }
          : entry,
      ),
    );
  }

  function markAllPresent() {
    if (!defaultCode) return;
    setEntries((prev) => prev.map((entry) => ({ ...entry, codeId: defaultCode.id, minutesLate: '' })));
    setLockedMessage(null);
  }

  const tally = React.useMemo(() => {
    const counts: Record<AttendanceCategory, number> = { present: 0, absent: 0, late: 0, excused: 0 };
    for (const entry of entries) {
      const category = codesById.get(entry.codeId)?.category;
      if (category) counts[category] += 1;
    }
    return counts;
  }, [entries, codesById]);

  const missingReasonEntries = entries.filter(
    (entry) => codesById.get(entry.codeId)?.requiresReason && !entry.note.trim(),
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const marks: MarkInput[] = entries.map((entry) => {
        const code = codesById.get(entry.codeId);
        const minutesLateValue =
          code?.category === 'late' && entry.minutesLate.trim() !== '' ? Number(entry.minutesLate) : undefined;
        return {
          personId: entry.personId,
          codeId: entry.codeId,
          ...(minutesLateValue !== undefined && !Number.isNaN(minutesLateValue) ? { minutesLate: minutesLateValue } : {}),
          ...(entry.note.trim() ? { note: entry.note.trim() } : {}),
        };
      });
      return markSession({ sectionMeetingId, date, idempotencyKey, marks });
    },
    onSuccess: (result) => {
      setLockedMessage(null);
      setIdempotencyKey(crypto.randomUUID());
      toast.success(result.replayed ? 'Already saved' : 'Register saved', {
        description: `${result.records.length} student${result.records.length === 1 ? '' : 's'} recorded for ${roster.periodName}, ${formatDateOnly(date)}.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['attendance', 'roster', sectionMeetingId, date] });
      void queryClient.invalidateQueries({ queryKey: ['attendance', 'unmarked'] });
      void queryClient.invalidateQueries({ queryKey: ['academic', 'timetable'] });
    },
    onError: (error: Error) => {
      // Marks are never cleared here (see EntryState's own home in
      // `entries`, untouched by this handler) - a failed submit, whatever
      // the cause, must never discard two minutes of a teacher's work.
      if (error instanceof AttendanceLockedError) {
        setLockedMessage(error.message);
        return;
      }
      toast.error('Could not save the register', { description: error.message });
    },
  });

  async function handleRequestCorrection(entry: EntryState) {
    if (!entry.existingRecordId) return;
    setCorrectionStatus((prev) => ({ ...prev, [entry.personId]: 'pending' }));
    try {
      await requestAttendanceCorrection({
        recordId: entry.existingRecordId,
        toCodeId: entry.codeId,
        reason: correctionReason.trim() || undefined,
      });
      setCorrectionStatus((prev) => ({ ...prev, [entry.personId]: 'done' }));
      toast.success('Correction requested', {
        description: `${entry.givenName} ${entry.familyName} - pending approval.`,
      });
    } catch (error) {
      setCorrectionStatus((prev) => ({ ...prev, [entry.personId]: 'error' }));
      toast.error('Could not request a correction', { description: (error as Error).message });
    }
  }

  const changedLockedEntries = lockedMessage
    ? entries.filter((entry) => entry.existingRecordId && entry.codeId !== entry.originalCodeId)
    : [];

  const isGenericSubmitError = mutation.isError && !(mutation.error instanceof AttendanceLockedError);
  const canSubmit = canWrite && missingReasonEntries.length === 0 && !mutation.isPending;

  return (
    <div className="flex flex-col gap-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-fg">{roster.periodName}</h1>
          <p className="text-sm text-fg-muted">
            {formatDateOnly(date)} · {roster.entries.length} student{roster.entries.length === 1 ? '' : 's'}
          </p>
        </div>
        {alreadyMarked ? <Badge variant="success">Already marked</Badge> : <Badge variant="neutral">Not yet marked</Badge>}
      </div>

      {!canWrite ? (
        <Alert variant="info">
          <AlertTitle>Read-only</AlertTitle>
          <AlertDescription>
            You have read-only access to this register - marking attendance requires the attendance.record:write
            permission.
          </AlertDescription>
        </Alert>
      ) : null}

      {alreadyMarked ? (
        <Alert variant="info">
          <AlertDescription>
            This register already has marks recorded. You can edit them for up to 24 hours after they were first
            saved - after that, changing a mark needs an approved correction instead of a direct save.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={markAllPresent} disabled={!canWrite || !defaultCode}>
          <CircleCheck className="size-4" />
          Mark all present
        </Button>
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(tally) as AttendanceCategory[]).map((category) =>
            tally[category] > 0 ? (
              <Badge key={category} variant={ATTENDANCE_CATEGORY_BADGE_VARIANT[category]}>
                {tally[category]} {ATTENDANCE_CATEGORY_LABELS[category]}
              </Badge>
            ) : null,
          )}
        </div>
        <span className="ms-auto text-xs text-fg-subtle">
          {entries.length - missingReasonEntries.length} of {entries.length} ready to save
        </span>
      </div>

      {missingReasonEntries.length > 0 ? (
        <Alert variant="danger">
          <AlertTitle>Add a reason before saving</AlertTitle>
          <AlertDescription>
            {missingReasonEntries.map((entry) => `${entry.givenName} ${entry.familyName}`).join(', ')} need
            {missingReasonEntries.length === 1 ? 's' : ''} a reason for the code selected.
          </AlertDescription>
        </Alert>
      ) : null}

      {lockedMessage ? (
        <Alert variant="warning">
          <AlertTitle>This register is locked</AlertTitle>
          <AlertDescription>
            These marks were saved more than 24 hours ago, so they can no longer be changed directly - request a
            correction for each changed student instead. An approved correction is required before the change takes
            effect; your edits below are still on screen.
          </AlertDescription>
          {changedLockedEntries.length > 0 ? (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="correction-reason" className="text-xs">
                  Reason (optional, applied to every request below)
                </Label>
                <Textarea
                  id="correction-reason"
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  placeholder="e.g. Confirmed with the student's parent."
                  className="min-h-16"
                />
              </div>
              <ul className="flex flex-col gap-2">
                {changedLockedEntries.map((entry) => {
                  const status = correctionStatus[entry.personId];
                  return (
                    <li
                      key={entry.personId}
                      className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-fg">
                          {entry.givenName} {entry.familyName}
                        </span>
                        <span className="text-xs text-fg-muted">
                          {codesById.get(entry.originalCodeId ?? '')?.label ?? '—'} →{' '}
                          {codesById.get(entry.codeId)?.label ?? '—'}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant={status === 'done' ? 'secondary' : 'outline'}
                        disabled={status === 'pending' || status === 'done'}
                        onClick={() => void handleRequestCorrection(entry)}
                      >
                        {status === 'done' ? 'Requested' : status === 'pending' ? 'Requesting…' : 'Request correction'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {isGenericSubmitError ? (
        <Alert variant="danger">
          <AlertTitle>Could not save the register</AlertTitle>
          <AlertDescription>{mutation.error?.message} Nothing was lost - your marks are still here, try again.</AlertDescription>
        </Alert>
      ) : null}

      <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
        {entries.map((entry) => {
          const selectedCode = codesById.get(entry.codeId);
          const needsReason = Boolean(selectedCode?.requiresReason);
          const missingReason = needsReason && !entry.note.trim();
          return (
            <li key={entry.personId} className={cn('flex flex-col gap-2.5 p-3.5', missingReason && 'bg-danger-soft')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">
                  {entry.givenName} {entry.familyName}
                </span>
                {entry.existingRecordId ? <span className="text-xs text-fg-subtle">Previously marked</span> : null}
              </div>

              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={`Attendance for ${entry.givenName} ${entry.familyName}`}
              >
                {sortedCodes.map((code) => {
                  const selected = code.id === entry.codeId;
                  return (
                    <button
                      key={code.id}
                      type="button"
                      disabled={!canWrite}
                      aria-pressed={selected}
                      onClick={() => selectCode(entry.personId, code.id)}
                      className={cn(
                        'min-h-11 min-w-[4.5rem] rounded-control border px-3 text-sm font-medium',
                        'transition-colors duration-150 ease-out motion-reduce:transition-none',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                        selected
                          ? SELECTED_CODE_CLASS[code.category]
                          : 'border-border-strong bg-surface text-fg hover:bg-surface-sunken',
                      )}
                    >
                      {code.label}
                    </button>
                  );
                })}
              </div>

              {selectedCode?.category === 'late' ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={`late-${entry.personId}`} className="text-xs text-fg-muted">
                    Minutes late
                  </Label>
                  <Input
                    id={`late-${entry.personId}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    disabled={!canWrite}
                    value={entry.minutesLate}
                    onChange={(event) => updateEntry(entry.personId, { minutesLate: event.target.value })}
                    className="h-8 w-24"
                  />
                </div>
              ) : null}

              {needsReason ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`note-${entry.personId}`} className="text-xs text-fg-muted">
                    Reason {missingReason ? <span className="text-danger">(required)</span> : null}
                  </Label>
                  <Textarea
                    id={`note-${entry.personId}`}
                    value={entry.note}
                    disabled={!canWrite}
                    onChange={(event) => updateEntry(entry.personId, { note: event.target.value })}
                    className={cn('min-h-14', missingReason && 'border-danger')}
                    placeholder={`Why is ${entry.givenName} marked "${selectedCode?.label}"?`}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canWrite ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-3 shadow-raised">
          <span className="text-xs text-fg-muted">
            {missingReasonEntries.length > 0
              ? `${missingReasonEntries.length} student${missingReasonEntries.length === 1 ? '' : 's'} need a reason`
              : `Ready to save ${entries.length} mark${entries.length === 1 ? '' : 's'}`}
          </span>
          {isGenericSubmitError ? (
            <Button variant="outline" onClick={() => mutation.mutate()} loading={mutation.isPending}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          ) : (
            <Button onClick={() => mutation.mutate()} disabled={!canSubmit} loading={mutation.isPending}>
              Save register
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
