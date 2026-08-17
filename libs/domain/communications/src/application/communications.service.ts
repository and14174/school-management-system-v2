import { Inject, Injectable } from '@nestjs/common';
import type { PersonId, Result } from '@sms/kernel';
import { ForbiddenError, err, type DomainError, type NotFoundError } from '@sms/kernel';
import type {
  Announcement,
  AnnouncementRecipientView,
  CommunicationsContract,
  CreateAnnouncementInput,
  ListAnnouncementsInput,
  ListThreadsInput,
  MarkAnnouncementReadInput,
  MarkThreadReadInput,
  PostMessageInput,
  PostMessageResult,
  StartThreadInput,
  SupersedeAnnouncementInput,
  Thread,
  ThreadDetail,
  UnreadCounts,
} from '../contract.js';
import { AnnouncementService } from './announcement.service.js';
import { ThreadService } from './thread.service.js';
import { currentTenantContext } from './current-context.js';

/**
 * Implements `CommunicationsContract`. Thin composition layer over
 * `AnnouncementService`/`ThreadService` - exactly the shape `AttendanceService`
 * composes `AttendanceCodeService`/`AttendanceRecordService`/
 * `AttendanceCorrectionService` in `@sms/attendance`. Every method resolves
 * the ambient tenant via `currentTenantContext()`; the services underneath
 * take `tenantId` explicitly so they also work from `seed.ts` and from tests
 * with no ambient context at all.
 *
 * The author of a `postMessage` is ALWAYS the ambient context's `personId` -
 * never client-supplied (see `CommunicationsContract.postMessage`'s own doc
 * comment) - so a caller with no linked person record cannot post at all,
 * which is the correct outcome: there is no person to attribute the message
 * to.
 */
@Injectable()
export class CommunicationsService implements CommunicationsContract {
  constructor(
    @Inject(AnnouncementService) private readonly announcements: AnnouncementService,
    @Inject(ThreadService) private readonly threads: ThreadService,
  ) {}

  createAnnouncement(input: CreateAnnouncementInput): Promise<Result<Announcement, DomainError>> {
    return this.announcements.createAnnouncement(currentTenantContext().tenantId, input);
  }

  publishAnnouncement(id: string): Promise<Result<Announcement, DomainError>> {
    return this.announcements.publishAnnouncement(currentTenantContext().tenantId, id);
  }

  supersedeAnnouncement(id: string, input: SupersedeAnnouncementInput): Promise<Result<Announcement, DomainError>> {
    return this.announcements.supersedeAnnouncement(currentTenantContext().tenantId, id, input);
  }

  getAnnouncement(id: string): Promise<Result<Announcement, NotFoundError>> {
    return this.announcements.getAnnouncement(currentTenantContext().tenantId, id);
  }

  listAnnouncements(input?: ListAnnouncementsInput): Promise<Announcement[]> {
    return this.announcements.listAnnouncements(currentTenantContext().tenantId, input ?? {});
  }

  listAnnouncementRecipients(announcementId: string): Promise<AnnouncementRecipientView[]> {
    return this.announcements.listAnnouncementRecipients(currentTenantContext().tenantId, announcementId);
  }

  isAnnouncementRecipient(announcementId: string, personId: PersonId): Promise<boolean> {
    return this.announcements.isAnnouncementRecipient(currentTenantContext().tenantId, announcementId, personId);
  }

  markAnnouncementRead(input: MarkAnnouncementReadInput): Promise<Result<void, NotFoundError>> {
    return this.announcements.markAnnouncementRead(currentTenantContext().tenantId, input);
  }

  startThread(input: StartThreadInput): Promise<Result<Thread, DomainError>> {
    const ctx = currentTenantContext();
    return this.threads.startThread(ctx.tenantId, ctx.actorUserId ?? ctx.userId ?? null, input);
  }

  postMessage(input: PostMessageInput): Promise<Result<PostMessageResult, DomainError>> {
    const ctx = currentTenantContext();
    if (!ctx.personId) {
      return Promise.resolve(err(new ForbiddenError('The caller has no linked person record and cannot post a message.')));
    }
    return this.threads.postMessage(ctx.tenantId, ctx.personId, input);
  }

  listThreads(input?: ListThreadsInput): Promise<Thread[]> {
    return this.threads.listThreads(currentTenantContext().tenantId, input ?? {});
  }

  getThread(id: string): Promise<Result<ThreadDetail, NotFoundError>> {
    return this.threads.getThread(currentTenantContext().tenantId, id);
  }

  isThreadParticipant(threadId: string, personId: PersonId): Promise<boolean> {
    return this.threads.isParticipant(currentTenantContext().tenantId, threadId, personId);
  }

  markThreadRead(input: MarkThreadReadInput): Promise<Result<void, NotFoundError>> {
    return this.threads.markThreadRead(currentTenantContext().tenantId, input);
  }

  async getUnreadCounts(personId: PersonId): Promise<UnreadCounts> {
    const tenantId = currentTenantContext().tenantId;
    const [unreadAnnouncements, unreadThreads] = await Promise.all([
      this.announcements.countUnreadAnnouncements(tenantId, personId),
      this.threads.countUnreadThreads(tenantId, personId),
    ]);
    return { personId, unreadAnnouncements, unreadThreads };
  }
}
