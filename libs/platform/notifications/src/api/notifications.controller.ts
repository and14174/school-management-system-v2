import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { ForbiddenError, isSystemContext, unwrap, type PersonId } from '@sms/kernel';
import { getContext } from '@sms/db';
import { ACCESS_CONTRACT, RequirePermission, type AccessContract } from '@sms/access';
import { NOTIFICATIONS_CONTRACT, type NotificationsContract } from '../contract.js';
import { PublishTemplateVersionDto, SetPreferenceDto } from './dto/notifications.dto.js';

/**
 * `api/v1/notifications/*`. `notify()` itself is deliberately NOT exposed
 * here - it is an in-process contract method for other modules (the
 * `AttendanceAbsenceSubscriber` included) to call, the same posture
 * `@sms/outbox`'s `OutboxContract.publish` takes toward REST.
 *
 * Preference endpoints additionally check OWNERSHIP, not just the coarse
 * `notifications.preference:manage` grant: `@RequirePermission` alone only
 * answers "may this user manage preferences AT ALL" - a route naming a
 * specific `personId` needs the scope-resolving second check, the same
 * "list/single-record read needs `resolveScopeConstraints` too" reasoning
 * `academic.section`'s `SectionsController` documents (see docs/decisions.md).
 * A caller whose grant resolves to `'own'` may only act on their OWN linked
 * person id (`ctx.personId`); a caller whose grant resolves to `'tenant'`
 * may act on anyone's.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(NOTIFICATIONS_CONTRACT) private readonly notifications: NotificationsContract,
    @Inject(ACCESS_CONTRACT) private readonly access: AccessContract,
  ) {}

  @RequirePermission('notifications.template:manage')
  @Get('templates')
  async listTemplates() {
    return this.notifications.listTemplates();
  }

  @RequirePermission('notifications.template:manage')
  @Post('templates/versions')
  async publishTemplateVersion(@Body(new ZodValidationPipe(PublishTemplateVersionDto)) body: PublishTemplateVersionDto) {
    return unwrap(await this.notifications.publishTemplateVersion(body));
  }

  @RequirePermission('notifications.delivery:read')
  @Get('deliveries')
  async listDeliveries(@Query('notificationId') notificationId?: string, @Query('personId') personId?: string) {
    return this.notifications.listDeliveries({ notificationId, personId: personId as PersonId | undefined });
  }

  @RequirePermission('notifications.preference:manage')
  @Get('preferences/:personId')
  async getPreferences(@Param('personId') personId: string) {
    await this.assertCanManagePreferences(personId);
    return this.notifications.getPreferences(personId as PersonId);
  }

  @RequirePermission('notifications.preference:manage')
  @Put('preferences/:personId')
  async setPreference(
    @Param('personId') personId: string,
    @Body(new ZodValidationPipe(SetPreferenceDto)) body: SetPreferenceDto,
  ) {
    await this.assertCanManagePreferences(personId);
    return unwrap(await this.notifications.setPreference({ ...body, personId: personId as PersonId }));
  }

  private async assertCanManagePreferences(targetPersonId: string): Promise<void> {
    const ctx = getContext();
    if (!ctx || isSystemContext(ctx) || !ctx.userId) {
      throw new ForbiddenError('No tenant is resolved for this request.');
    }

    const constraints = await this.access.resolveScopeConstraints(ctx.userId, ctx.tenantId);
    const constraint = constraints['notifications.preference:manage'];

    if (!constraint || constraint.kind === 'none') {
      throw new ForbiddenError('Missing permission "notifications.preference:manage".');
    }
    if (constraint.kind === 'tenant') {
      return;
    }
    if (constraint.kind === 'own' && ctx.personId && ctx.personId === targetPersonId) {
      return;
    }

    throw new ForbiddenError('Missing permission "notifications.preference:manage" for this person.');
  }
}
