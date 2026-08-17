'use client';

import { ArrowRight, Circle } from 'lucide-react';
import { Badge } from '@sms/ui';
import type { AuthUser } from '../../../../lib/auth-client';
import type { EnrollmentStatusEvent } from '../../../../lib/api';
import { ENROLLMENT_STATUS_BADGE_VARIANT, ENROLLMENT_STATUS_LABELS, formatActorLabel, formatDateOnly, formatTimestamp } from '../format';

export interface StatusTimelineProps {
  events: EnrollmentStatusEvent[];
  currentUser: AuthUser | null;
}

/**
 * The status_event history, rendered as an immutable log - newest first,
 * every field the API returns shown as-is, nothing editable. This is a
 * legal record (who changed a student's enrolment status, when, and why),
 * not a form: there is deliberately no edit/delete affordance anywhere in
 * this component, matching `EnrollmentContract.transitionStatus`'s own
 * comment that the history is "never overwritten, only ever appended to".
 */
export function StatusTimeline({ events, currentUser }: StatusTimelineProps) {
  const newestFirst = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (newestFirst.length === 0) {
    return <p className="text-sm text-fg-subtle">No status history recorded yet.</p>;
  }

  return (
    <ol className="flex flex-col">
      {newestFirst.map((event, index) => (
        <li key={event.id} className="relative flex gap-3 pb-6 last:pb-0">
          {index < newestFirst.length - 1 ? (
            <span className="absolute start-[7px] top-5 h-full w-px bg-border" aria-hidden />
          ) : null}
          <span className="relative z-10 mt-1.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface">
            <Circle className="size-3 fill-primary text-primary" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-card border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              {event.fromStatus ? (
                <>
                  <Badge variant={ENROLLMENT_STATUS_BADGE_VARIANT[event.fromStatus]}>
                    {ENROLLMENT_STATUS_LABELS[event.fromStatus]}
                  </Badge>
                  <ArrowRight className="size-3.5 text-fg-subtle" />
                </>
              ) : (
                <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Opened as</span>
              )}
              <Badge variant={ENROLLMENT_STATUS_BADGE_VARIANT[event.toStatus]}>
                {ENROLLMENT_STATUS_LABELS[event.toStatus]}
              </Badge>
            </div>
            <p className="text-xs text-fg-subtle" data-tabular>
              Effective {formatDateOnly(event.effectiveOn)} · Recorded {formatTimestamp(event.createdAt)} ·{' '}
              {formatActorLabel(event.actorUserId, currentUser)}
            </p>
            {event.reason ? <p className="text-sm text-fg-muted">{event.reason}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
