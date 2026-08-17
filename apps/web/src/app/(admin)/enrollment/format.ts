import { format, parseISO } from 'date-fns';
import type { AuthUser } from '../../../lib/auth-client';
import type { EnrollmentStatus } from '../../../lib/api';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Task brief: "applied informational, enrolled neutral/success, withdrawn/
 * transferred_out muted, graduated positive." `neutral` here doubles as
 * "muted" - the shared Badge's `neutral` variant already renders in
 * `text-fg-muted` (see libs/shared/ui/src/components/badge.tsx), so a
 * separate "muted" variant isn't needed.
 */
export const ENROLLMENT_STATUS_BADGE_VARIANT: Record<EnrollmentStatus, BadgeVariant> = {
  applied: 'info',
  enrolled: 'success',
  withdrawn: 'neutral',
  transferred_out: 'neutral',
  graduated: 'success',
};

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  applied: 'Applied',
  enrolled: 'Enrolled',
  withdrawn: 'Withdrawn',
  transferred_out: 'Transferred out',
  graduated: 'Graduated',
};

export function formatDateOnly(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy');
}

export function formatTimestamp(value: string): string {
  return format(parseISO(value), 'MMM d, yyyy, h:mm a');
}

/**
 * Same honest limitation as settings/import/format.ts's `formatActorLabel`:
 * no user directory endpoint exists in the pinned API, so an
 * `actorUserId`/`createdByUserId` can only be resolved to a name when it
 * matches the currently signed-in user.
 */
export function formatActorLabel(userId: string | null | undefined, currentUser: AuthUser | null): string {
  if (!userId) return 'System';
  if (currentUser && userId === currentUser.id) return `You (${currentUser.name})`;
  return `User …${userId.slice(-6)}`;
}
