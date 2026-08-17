import { Body, Controller, Delete, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type UserId } from '@sms/kernel';
import { ACCESS_CONTRACT, type AccessContract } from '../contract.js';
import { StartImpersonationDto } from './dto/impersonation.dto.js';
import { RequirePermission } from './require-permission.decorator.js';

@ApiTags('access')
@Controller('access/impersonation')
export class ImpersonationController {
  constructor(@Inject(ACCESS_CONTRACT) private readonly access: AccessContract) {}

  @RequirePermission('access.impersonation:create')
  @Post()
  async start(@Body(new ZodValidationPipe(StartImpersonationDto)) body: StartImpersonationDto) {
    return unwrap(await this.access.startImpersonation({ targetUserId: body.targetUserId as UserId, reason: body.reason }));
  }

  // No @RequirePermission: ending your own impersonation session must
  // always be possible for whoever started it - it is not a privileged
  // action the way starting one is, and AccessService.endImpersonation only
  // ever acts on the ambient caller's own session (see its comment).
  @Delete()
  async end() {
    // Report what actually happened, not what was requested.
    const ended = unwrap(await this.access.endImpersonation());
    return { ended };
  }
}
