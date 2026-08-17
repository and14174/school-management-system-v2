import { Body, Controller, Get, Header, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap } from '@sms/kernel';
import { RequirePermission } from '@sms/access';
import { IMPORT_EXPORT_CONTRACT, type ImportExportContract, type ImportRowOutcome } from '../contract.js';
import { CreateJobDto, SetMappingDto } from './dto/import-job.dto.js';

/**
 * `api/v1/import/*`. Gated with `@RequirePermission('people.person:write'/':read')`
 * rather than a dedicated `import.job:read`/`import.job:write` pair, because
 * this module may not edit `@sms/access`'s permission catalogue (another
 * agent owns that file concurrently - see the module report). `people.person`
 * is the only entity type actually importable today (the concrete target
 * `apps/api` registers), so gating on it is not a stretch, but a real
 * `import.job:*` pair independent of any one target's own permission should
 * be added once the catalogue is free to change.
 */
@ApiTags('import-export')
@Controller('import')
export class ImportExportController {
  constructor(@Inject(IMPORT_EXPORT_CONTRACT) private readonly importExport: ImportExportContract) {}

  @RequirePermission('people.person:read')
  @Get('targets')
  async listTargets() {
    return this.importExport.listTargets();
  }

  @RequirePermission('people.person:write')
  @Post('jobs')
  async createJob(@Body(new ZodValidationPipe(CreateJobDto)) body: CreateJobDto) {
    return unwrap(await this.importExport.createJob(body));
  }

  @RequirePermission('people.person:read')
  @Get('jobs')
  async listJobs() {
    return this.importExport.listJobs();
  }

  @RequirePermission('people.person:read')
  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    return unwrap(await this.importExport.getJob(id));
  }

  @RequirePermission('people.person:write')
  @Post('jobs/:id/mapping')
  async setMapping(@Param('id') id: string, @Body(new ZodValidationPipe(SetMappingDto)) body: SetMappingDto) {
    return unwrap(await this.importExport.setMapping(id, body));
  }

  @RequirePermission('people.person:write')
  @Post('jobs/:id/dry-run')
  async dryRun(@Param('id') id: string) {
    return unwrap(await this.importExport.dryRun(id));
  }

  @RequirePermission('people.person:write')
  @Post('jobs/:id/commit')
  async commit(@Param('id') id: string) {
    return unwrap(await this.importExport.commit(id));
  }

  @RequirePermission('people.person:write')
  @Post('jobs/:id/revert')
  async revert(@Param('id') id: string) {
    return unwrap(await this.importExport.revert(id));
  }

  @RequirePermission('people.person:read')
  @Get('jobs/:id/rows')
  async listRows(
    @Param('id') id: string,
    @Query('outcome') outcome?: ImportRowOutcome,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.importExport.listRows(id, {
      ...(outcome ? { outcome } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }

  // Buffers the (stream-friendly) contract method into one response body -
  // a real chunked Fastify response is future work; ImportExportContract's
  // exportCsv is already an AsyncIterable so wiring that up later does not
  // touch application code, only this handler.
  @RequirePermission('people.person:read')
  @Get('export/:entityType')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(@Param('entityType') entityType: string, @Res({ passthrough: true }) reply: FastifyReply) {
    let csv = '';
    for await (const chunk of this.importExport.exportCsv(entityType)) {
      csv += chunk;
    }
    reply.header('Content-Disposition', `attachment; filename="${entityType}-export.csv"`);
    return csv;
  }
}
