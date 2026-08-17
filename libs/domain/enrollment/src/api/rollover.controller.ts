import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type AcademicYearId } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { ENROLLMENT_CONTRACT, type EnrollmentContract } from '../contract.js';
import { RollOverYearDto } from './dto/enrollment.dto.js';

@ApiTags('enrollment')
@Controller('enrollment')
export class RolloverController {
  constructor(@Inject(ENROLLMENT_CONTRACT) private readonly enrollment: EnrollmentContract) {}

  /**
   * Gated separately from `enrollment.enrollment:write` - rolling an entire
   * academic year over is a much bigger blast radius than editing one
   * enrolment, so it gets its own permission (`enrollment.rollover:run`),
   * granted to Registrar/School Administrator but not to every role that
   * can write a single enrolment.
   */
  @RequirePermission('enrollment.rollover:run')
  @Post('rollover')
  async rollOverYear(@Body(new ZodValidationPipe(RollOverYearDto)) body: RollOverYearDto) {
    return unwrap(
      await this.enrollment.rollOverYear({
        fromAcademicYearId: body.fromAcademicYearId as AcademicYearId,
        toAcademicYearId: body.toAcademicYearId as AcademicYearId,
        promotionMap: body.promotionMap,
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      }),
    );
  }
}
