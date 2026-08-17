import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type AcademicYearId, type DateOnly } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { ACADEMIC_CONTRACT, type AcademicContract } from '../contract.js';
import { CreateGradingPeriodDto, CreateTermDto, UpdateTermDto } from './dto/term.dto.js';

@ApiTags('academic')
@Controller('academic')
export class TermsController {
  constructor(@Inject(ACADEMIC_CONTRACT) private readonly academic: AcademicContract) {}

  @RequirePermission('academic.term:read')
  @Get('terms')
  listTerms(@Query('academicYearId') academicYearId?: string) {
    return this.academic.listTerms(academicYearId as AcademicYearId | undefined);
  }

  @RequirePermission('academic.term:write')
  @Post('terms')
  async createTerm(@Body(new ZodValidationPipe(CreateTermDto)) body: CreateTermDto) {
    return unwrap(
      await this.academic.createTerm({
        academicYearId: body.academicYearId as AcademicYearId,
        name: body.name,
        startsOn: body.startsOn as DateOnly,
        endsOn: body.endsOn as DateOnly,
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
      }),
    );
  }

  @RequirePermission('academic.term:write')
  @Patch('terms/:id')
  async updateTerm(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateTermDto)) body: UpdateTermDto) {
    return unwrap(
      await this.academic.updateTerm(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.startsOn !== undefined ? { startsOn: body.startsOn as DateOnly } : {}),
        ...(body.endsOn !== undefined ? { endsOn: body.endsOn as DateOnly } : {}),
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
      }),
    );
  }

  @RequirePermission('academic.term:read')
  @Get('terms/:id/grading-periods')
  listGradingPeriods(@Param('id', ParseUUIDPipe) id: string) {
    return this.academic.listGradingPeriods(id);
  }

  @RequirePermission('academic.term:write')
  @Post('terms/:id/grading-periods')
  async createGradingPeriod(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreateGradingPeriodDto)) body: CreateGradingPeriodDto) {
    return unwrap(
      await this.academic.createGradingPeriod({
        termId: id,
        name: body.name,
        startsOn: body.startsOn as DateOnly,
        endsOn: body.endsOn as DateOnly,
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
      }),
    );
  }
}
