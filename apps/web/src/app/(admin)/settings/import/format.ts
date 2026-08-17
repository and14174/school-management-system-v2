import { format, parseISO } from 'date-fns';
import type { AuthUser } from '../../../../lib/auth-client';
import type { ImportJobStatus, ImportRowOutcome } from '../../../../lib/api';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const IMPORT_JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  mapping: 'Mapping',
  validating: 'Validating…',
  previewed: 'Previewed',
  committing: 'Committing…',
  completed: 'Completed',
  failed: 'Failed',
  reverted: 'Reverted',
};

export const IMPORT_JOB_STATUS_BADGE_VARIANT: Record<ImportJobStatus, BadgeVariant> = {
  mapping: 'neutral',
  validating: 'info',
  previewed: 'info',
  committing: 'info',
  completed: 'success',
  failed: 'danger',
  reverted: 'warning',
};

export const IMPORT_ROW_OUTCOME_LABELS: Record<ImportRowOutcome, string> = {
  pending: 'Pending',
  valid: 'Valid',
  error: 'Error',
  created: 'Created',
  updated: 'Updated',
  skipped: 'Skipped',
};

export function formatTimestamp(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy, h:mm a');
}

/**
 * No user directory endpoint exists anywhere in the pinned API (see the
 * module report) - a `createdByUserId`/`actorUserId` can only ever be
 * resolved to a display name when it happens to match the CURRENTLY signed
 * in user (from /auth/me, already held in the session). Anyone else's id is
 * shown, shortened, as itself rather than invented or hidden - honest about
 * what the client can and cannot know, not a stand-in for a directory
 * lookup this task cannot add (apps/api and libs/platform/access are
 * off-limits here).
 */
export function formatActorLabel(userId: string | null | undefined, currentUser: AuthUser | null): string {
  if (!userId) return 'System';
  if (currentUser && userId === currentUser.id) return `You (${currentUser.name})`;
  return `User …${userId.slice(-6)}`;
}
