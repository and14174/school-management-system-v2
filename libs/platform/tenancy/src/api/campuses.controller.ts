import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type CampusId } from '@sms/kernel';
import { CampusService } from '../application/campus.service.js';
import { CreateCampusDto, UpdateCampusDto } from './dto/campus.dto.js';

@ApiTags('tenancy')
@Controller('tenancy/campuses')
export class CampusesController {
  // Explicit @Inject(): see apps/api's HealthController for why implicit
  // type-based DI is not trusted in this codebase.
  constructor(@Inject(CampusService) private readonly campuses: CampusService) {}

  @Get()
  list() {
    return this.campuses.list();
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.campuses.getById(id as CampusId));
  }

  // `new ZodValidationPipe(CreateCampusDto)` explicitly, rather than relying
  // on the global pipe's metatype auto-detection: same reasoning as the
  // explicit @Inject() above - esbuild/tsx's emitDecoratorMetadata output
  // is not reliable enough here to trust for picking the right DTO either.
  @Post()
  async create(@Body(new ZodValidationPipe(CreateCampusDto)) body: CreateCampusDto) {
    return unwrap(await this.campuses.create(body));
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateCampusDto)) body: UpdateCampusDto,
  ) {
    return unwrap(await this.campuses.updateById(id as CampusId, body));
  }
}
