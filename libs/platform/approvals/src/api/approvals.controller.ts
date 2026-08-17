import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { APPROVALS_CONTRACT, type ApprovalRequestStatus, type ApprovalsContract } from '../contract.js';
import { DecideRequestDto, UpsertPolicyDto } from './dto/approvals.dto.js';

/**
 * `api/v1/approvals/*`. Policy management and request/decision *reading* are
 * gated by the two catalogue permissions this module ships
 * (`approvals.policy:manage`, `approvals.request:read` - see the module
 * brief). There is deliberately no generic "approve" permission: whether a
 * caller may DECIDE a given request is resolved inside
 * `ApprovalsService.decide` against the permission that request's OWN policy
 * names, checked against the caller's real compiled ability - see that
 * method's own comment. `decide` is therefore gated here only by
 * `approvals.request:read` (the caller must at least be allowed to see
 * approval activity at all); the actual authority to move a specific request
 * is decided per-request, not by this route guard.
 */
@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(@Inject(APPROVALS_CONTRACT) private readonly approvals: ApprovalsContract) {}

  @RequirePermission('approvals.policy:manage')
  @Post('policies')
  async upsertPolicy(@Body(new ZodValidationPipe(UpsertPolicyDto)) body: UpsertPolicyDto) {
    return unwrap(
      await this.approvals.upsertPolicy({
        requestType: body.requestType,
        permissionKey: body.permissionKey,
        ...(body.approvalsRequired !== undefined ? { approvalsRequired: body.approvalsRequired } : {}),
      }),
    );
  }

  @RequirePermission('approvals.policy:manage')
  @Get('policies')
  listPolicies() {
    return this.approvals.listPolicies();
  }

  @RequirePermission('approvals.policy:manage')
  @Get('policies/:requestType')
  getPolicy(@Param('requestType') requestType: string) {
    return this.approvals.getPolicy(requestType);
  }

  @RequirePermission('approvals.request:read')
  @Get('requests')
  listRequests(@Query('requestType') requestType?: string, @Query('status') status?: string) {
    return this.approvals.listRequests({
      ...(requestType ? { requestType } : {}),
      ...(status ? { status: status as ApprovalRequestStatus } : {}),
    });
  }

  @RequirePermission('approvals.request:read')
  @Get('requests/:id')
  async getRequest(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.approvals.getRequest(id));
  }

  @RequirePermission('approvals.request:read')
  @Post('requests/:id/decide')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DecideRequestDto)) body: DecideRequestDto) {
    return unwrap(
      await this.approvals.decide({
        requestId: id,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
      }),
    );
  }
}
