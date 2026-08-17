import type { CampusId, PersonId, TenantId, UserId } from '@sms/kernel';

export type AnnouncementStatus = 'draft' | 'published' | 'superseded';
export const ANNOUNCEMENT_STATUSES: readonly AnnouncementStatus[] = ['draft', 'published', 'superseded'];

export type ThreadSubjectType = 'people.person' | 'academic.section' | 'billing.invoice' | 'other';
export const THREAD_SUBJECT_TYPES: readonly ThreadSubjectType[] = [
  'people.person',
  'academic.section',
  'billing.invoice',
  'other',
];

export type ThreadStatus = 'open' | 'closed';
export const THREAD_STATUSES: readonly ThreadStatus[] = ['open', 'closed'];

export type ThreadParticipantRole = 'owner' | 'participant' | 'observer';
export const THREAD_PARTICIPANT_ROLES: readonly ThreadParticipantRole[] = ['owner', 'participant', 'observer'];

/**
 * The query used to resolve an announcement's audience - kept on
 * `Announcement.audience` for display ("sent to: all Grade 9 parents") only.
 * The actual answer, frozen at publish time, is the set of
 * `AnnouncementRecipient` rows `publishAnnouncement` writes - see the `1350`
 * migration header and `AnnouncementService.resolveAudience`.
 *
 * Every kind except `personIds` resolves to the GUARDIANS (`people.
 * relationship.may_receive_comms = true`) of students currently enrolled
 * matching the filter - an announcement is addressed to parents, not
 * directly to the students themselves. `personIds` is the escape hatch for
 * an audience that isn't expressible as a school/campus/grade-level filter
 * (e.g. staff, or a hand-picked list).
 */
export type AudienceQuery =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'campus'; readonly campusId: CampusId }
  | { readonly kind: 'gradeLevel'; readonly gradeLevelId: string }
  | { readonly kind: 'personIds'; readonly personIds: readonly PersonId[] };

/** Mirrors `communications.announcement`. See the `1350` migration header for the immutable-once-published design. */
export interface Announcement {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly audience: AudienceQuery;
  readonly campusId: CampusId | null;
  readonly status: AnnouncementStatus;
  readonly publishedAt: Date | null;
  readonly publishedByUserId: UserId | null;
  readonly supersededByAnnouncementId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `communications.announcement_recipient`: the FROZEN audience, one row per person addressed at publish time. */
export interface AnnouncementRecipient {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly announcementId: string;
  readonly personId: PersonId;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** Mirrors `communications.thread`. Always anchored to `subjectType`/`subjectId` - see the `1350` migration header. */
export interface Thread {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subject: string;
  readonly subjectType: ThreadSubjectType;
  readonly subjectId: string;
  readonly status: ThreadStatus;
  readonly createdByUserId: UserId | null;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `communications.thread_participant`. `lastReadAt` is what per-participant read state ("who has actually seen this") is computed from. */
export interface ThreadParticipant {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly threadId: string;
  readonly personId: PersonId;
  readonly role: ThreadParticipantRole;
  readonly lastReadAt: Date | null;
  readonly muted: boolean;
  readonly createdAt: Date;
}

/** Mirrors `communications.message`. Append-only - see the `1350` migration header. */
export interface Message {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly threadId: string;
  readonly authorPersonId: PersonId;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly sentAt: Date;
}

/** What `getThread` returns: the thread, who is in it, and its messages oldest-first - the marking-screen-equivalent single data source for the thread view. */
export interface ThreadDetail {
  readonly thread: Thread;
  readonly participants: readonly ThreadParticipant[];
  readonly messages: readonly Message[];
}

/** What `getUnreadCounts` reports: unread announcements and threads with unread messages, for a portal badge. */
export interface UnreadCounts {
  readonly personId: PersonId;
  readonly unreadAnnouncements: number;
  readonly unreadThreads: number;
}

/** One row of `listAnnouncementRecipients` - the frozen audience, joined with each person's read state. */
export interface AnnouncementRecipientView extends AnnouncementRecipient {
  readonly givenName: string;
  readonly familyName: string;
}
