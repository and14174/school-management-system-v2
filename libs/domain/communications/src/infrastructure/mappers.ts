import type { CampusId, PersonId, TenantId, UserId } from '@sms/kernel';
import type {
  Announcement,
  AnnouncementRecipient,
  AnnouncementRecipientView,
  AnnouncementStatus,
  AudienceQuery,
  Message,
  Thread,
  ThreadParticipant,
  ThreadParticipantRole,
  ThreadStatus,
  ThreadSubjectType,
} from '../domain/types.js';
import type { announcementRecipientTable, announcementTable, messageTable, threadParticipantTable, threadTable } from './schema.js';

type AnnouncementRow = typeof announcementTable.$inferSelect;
type AnnouncementRecipientRow = typeof announcementRecipientTable.$inferSelect;
type ThreadRow = typeof threadTable.$inferSelect;
type ThreadParticipantRow = typeof threadParticipantTable.$inferSelect;
type MessageRow = typeof messageTable.$inferSelect;

export function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    title: row.title,
    body: row.body,
    category: row.category,
    audience: row.audience as AudienceQuery,
    campusId: (row.campusId as CampusId | null) ?? null,
    status: row.status as AnnouncementStatus,
    publishedAt: row.publishedAt,
    publishedByUserId: (row.publishedByUserId as UserId | null) ?? null,
    supersededByAnnouncementId: row.supersededByAnnouncementId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAnnouncementRecipient(row: AnnouncementRecipientRow): AnnouncementRecipient {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    announcementId: row.announcementId,
    personId: row.personId as PersonId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/** The shape of the raw cross-schema `SELECT` `AnnouncementService.listAnnouncementRecipients` runs (snake_case columns, not the drizzle camelCase row type - see that method's own comment on why it is raw SQL). */
type RawRecipientViewRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly announcement_id: string;
  readonly person_id: string;
  readonly read_at: Date | null;
  readonly created_at: Date;
  readonly given_name: string;
  readonly family_name: string;
};

export function toAnnouncementRecipientView(row: RawRecipientViewRow): AnnouncementRecipientView {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    announcementId: row.announcement_id,
    personId: row.person_id as PersonId,
    readAt: row.read_at,
    createdAt: row.created_at,
    givenName: row.given_name,
    familyName: row.family_name,
  };
}

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    subject: row.subject,
    subjectType: row.subjectType as ThreadSubjectType,
    subjectId: row.subjectId,
    status: row.status as ThreadStatus,
    createdByUserId: (row.createdByUserId as UserId | null) ?? null,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toThreadParticipant(row: ThreadParticipantRow): ThreadParticipant {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    threadId: row.threadId,
    personId: row.personId as PersonId,
    role: row.role as ThreadParticipantRole,
    lastReadAt: row.lastReadAt,
    muted: row.muted,
    createdAt: row.createdAt,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    threadId: row.threadId,
    authorPersonId: row.authorPersonId as PersonId,
    body: row.body,
    idempotencyKey: row.idempotencyKey,
    sentAt: row.sentAt,
  };
}
