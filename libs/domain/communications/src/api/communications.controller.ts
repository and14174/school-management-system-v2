import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type CampusId, type PersonId } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract, type ScopeConstraint } from '@sms/access';
import { COMMUNICATIONS_CONTRACT, type CommunicationsContract } from '../contract.js';
import type { AudienceQuery, ThreadSubjectType } from '../domain/types.js';
import { CreateAnnouncementDto, PostMessageDto, StartThreadDto, SupersedeAnnouncementDto } from './dto/communications.dto.js';

/**
 * Gated with the two EXISTING `@sms/access` permissions this module was told
 * to reuse rather than add its own catalogue entries to a catalogue another
 * agent is editing concurrently (see the module report):
 *
 *   people.person:read   - held only by Administrator/Registrar (tenant
 *                           scope) - the privileged half: creating/
 *                           publishing/superseding an announcement, and
 *                           browsing its frozen recipient list.
 *   people.student:read  - held by Administrator/Registrar (tenant),
 *                           Teacher (section) AND Parent/Guardian/Student
 *                           (own) - see @sms/access's seed.ts. Gates every
 *                           read (and thread write) so a parent/teacher can
 *                           actually reach their own announcements/threads
 *                           in the live demo, not just an admin.
 *
 * `communications.announcement:read`/`:publish` and `communications.
 * thread:participate` are the dedicated permissions that should replace
 * these once the access catalogue settles - see the module report.
 *
 * `@RequirePermission` only answers "may this user touch communications AT
 * ALL" - same limitation `@sms/attendance`'s `AttendanceController` documents
 * at its own top. The data-filtering half (`resolveScopeConstraints`) is
 * applied to every read below, list AND single - `own`/`section`/`campus`/
 * `none` all collapse to "restricted to the caller's own participation",
 * enforced in the query (`ThreadService.listThreads`'s participant JOIN,
 * `ThreadService.isParticipant`'s targeted check before a single-thread
 * read) rather than by fetching everything and filtering the response.
 */
@ApiTags('communications')
@Controller('communications')
export class CommunicationsController {
  constructor(
    @Inject(COMMUNICATIONS_CONTRACT) private readonly communications: CommunicationsContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  // ---------------------------------------------------------------------
  // Announcements - creation/publish/supersede are the privileged actions
  // (people.person:read, held only tenant-wide by Administrator/Registrar);
  // reading is people.student:read, scoped to the caller's own frozen
  // recipient rows for anyone without a tenant-wide grant.
  // ---------------------------------------------------------------------

  @RequirePermission('people.person:read')
  @Post('announcements')
  async createAnnouncement(@Body(new ZodValidationPipe(CreateAnnouncementDto)) body: CreateAnnouncementDto) {
    return unwrap(
      await this.communications.createAnnouncement({
        title: body.title,
        body: body.body,
        category: body.category,
        // zod's discriminated union already validated `audience`'s shape -
        // the cast bridges its plain-string ids to the domain module's
        // branded `AudienceQuery`.
        audience: body.audience as AudienceQuery,
        campusId: (body.campusId ?? null) as CampusId | null,
      }),
    );
  }

  @RequirePermission('people.person:read')
  @Post('announcements/:id/publish')
  async publishAnnouncement(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.communications.publishAnnouncement(id));
  }

  @RequirePermission('people.person:read')
  @Post('announcements/:id/supersede')
  async supersedeAnnouncement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SupersedeAnnouncementDto)) body: SupersedeAnnouncementDto,
  ) {
    return unwrap(await this.communications.supersedeAnnouncement(id, body));
  }

  @RequirePermission('people.person:read')
  @Get('announcements/:id/recipients')
  listAnnouncementRecipients(@Param('id', ParseUUIDPipe) id: string) {
    return this.communications.listAnnouncementRecipients(id);
  }

  @RequirePermission('people.student:read')
  @Get('announcements')
  async listAnnouncements(@Query('forPersonId') forPersonId?: string) {
    const constraint = await this.resolveConstraint('people.student:read');
    if (constraint.kind === 'tenant') {
      return this.communications.listAnnouncements(forPersonId ? { forPersonId: forPersonId as PersonId } : {});
    }
    // Non-tenant scope: the caller's OWN participation only, regardless of
    // any forPersonId they supplied - never let a caller probe someone
    // else's announcements by naming them in the query string.
    const personId = this.requireOwnPersonId();
    return this.communications.listAnnouncements({ forPersonId: personId });
  }

  @RequirePermission('people.student:read')
  @Get('announcements/:id')
  async getAnnouncement(@Param('id', ParseUUIDPipe) id: string) {
    const constraint = await this.resolveConstraint('people.student:read');
    if (constraint.kind !== 'tenant') {
      const personId = this.requireOwnPersonId();
      const isRecipient = await this.communications.isAnnouncementRecipient(id, personId);
      if (!isRecipient) {
        throw new ForbiddenError(`You do not have access to announcement ${id}.`);
      }
    }
    return unwrap(await this.communications.getAnnouncement(id));
  }

  @RequirePermission('people.student:read')
  @Post('announcements/:id/read')
  async markAnnouncementRead(@Param('id', ParseUUIDPipe) id: string) {
    const personId = this.requireOwnPersonId();
    unwrap(await this.communications.markAnnouncementRead({ announcementId: id, personId }));
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Threads & messages - people.student:read, scoped to the caller's own
  // participation for anyone without a tenant-wide grant. Writes
  // (postMessage/markThreadRead) are additionally enforced by ThreadService
  // itself requiring a real thread_participant row, in the SAME transaction
  // as the write - belt and suspenders, not a substitute for the guard here.
  // ---------------------------------------------------------------------

  @RequirePermission('people.student:read')
  @Post('threads')
  async startThread(@Body(new ZodValidationPipe(StartThreadDto)) body: StartThreadDto) {
    return unwrap(
      await this.communications.startThread({
        subject: body.subject,
        subjectType: body.subjectType as ThreadSubjectType,
        subjectId: body.subjectId,
        participantPersonIds: body.participantPersonIds as PersonId[],
        firstMessage: body.firstMessage,
      }),
    );
  }

  @RequirePermission('people.student:read')
  @Get('threads')
  async listThreads(
    @Query('personId') personIdParam?: string,
    @Query('subjectType') subjectType?: string,
    @Query('subjectId') subjectId?: string,
  ) {
    const constraint = await this.resolveConstraint('people.student:read');
    const base = {
      ...(subjectType ? { subjectType: subjectType as ThreadSubjectType } : {}),
      ...(subjectId ? { subjectId } : {}),
    };
    if (constraint.kind === 'tenant') {
      return this.communications.listThreads({ ...base, ...(personIdParam ? { personId: personIdParam as PersonId } : {}) });
    }
    const personId = this.requireOwnPersonId();
    return this.communications.listThreads({ ...base, personId });
  }

  @RequirePermission('people.student:read')
  @Get('threads/:id')
  async getThread(@Param('id', ParseUUIDPipe) id: string) {
    const constraint = await this.resolveConstraint('people.student:read');
    if (constraint.kind !== 'tenant') {
      const personId = this.requireOwnPersonId();
      // A real, targeted query - never fetched-then-filtered. See this
      // controller's own top-of-file comment.
      const isParticipant = await this.communications.isThreadParticipant(id, personId);
      if (!isParticipant) {
        throw new ForbiddenError(`You do not have access to thread ${id}.`);
      }
    }
    return unwrap(await this.communications.getThread(id));
  }

  @RequirePermission('people.student:read')
  @Post('threads/:id/messages')
  async postMessage(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PostMessageDto)) body: PostMessageDto) {
    return unwrap(await this.communications.postMessage({ threadId: id, body: body.body, idempotencyKey: body.idempotencyKey }));
  }

  @RequirePermission('people.student:read')
  @Post('threads/:id/read')
  async markThreadRead(@Param('id', ParseUUIDPipe) id: string) {
    const personId = this.requireOwnPersonId();
    unwrap(await this.communications.markThreadRead({ threadId: id, personId }));
    return { ok: true };
  }

  @RequirePermission('people.student:read')
  @Get('unread-counts')
  getUnreadCounts() {
    const personId = this.requireOwnPersonId();
    return this.communications.getUnreadCounts(personId);
  }

  // ---------------------------------------------------------------------
  // Scope-constraint helpers - the data-filtering half `@RequirePermission`
  // cannot do on its own (see this file's top-of-file comment).
  // ---------------------------------------------------------------------

  private async resolveConstraint(permissionKey: string): Promise<ScopeConstraint> {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No authenticated tenant context is resolved for this request.');
    }
    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    return constraints[permissionKey] ?? { kind: 'none' };
  }

  /** The caller's own linked `people.person` id - required for every "my own" read/write below. `ForbiddenError`, never a silent empty result, when the caller has none: a login with no linked person has nothing of their own to see. */
  private requireOwnPersonId(): PersonId {
    const ctx = requireContext();
    if (isSystemContext(ctx) || !ctx.personId) {
      throw new ForbiddenError('The caller has no linked person record.');
    }
    return ctx.personId;
  }
}
