import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type AcademicYearId } from '@sms/kernel';
import { AcademicYearService } from '../application/academic-year.service.js';
import { CreateAcademicYearDto, UpdateAcademicYearDto } from './dto/academic-year.dto.js';

@ApiTags('tenancy')
@Controller('tenancy/academic-years')
export class AcademicYearsController {
  // Explicit @Inject(): see apps/api's HealthController for why implicit
  // type-based DI is not trusted in this codebase.
  constructor(@Inject(AcademicYearService) private readonly academicYears: AcademicYearService) {}

  @Get()
  list() {
    return this.academicYears.list();
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.academicYears.getById(id as AcademicYearId));
  }

  // `new ZodValidationPipe(dto)` explicitly - see campuses.controller.ts for why.
  @Post()
  async create(@Body(new ZodValidationPipe(CreateAcademicYearDto)) body: CreateAcademicYearDto) {
    return unwrap(await this.academicYears.create(body));
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateAcademicYearDto)) body: UpdateAcademicYearDto,
  ) {
    return unwrap(await this.academicYears.updateById(id as AcademicYearId, body));
  }
}
