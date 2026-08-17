import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  ForbiddenError,
  newId,
  type AcademicYearId,
  type CampusId,
  type DomainError,
  type NotFoundError,
  type Result,
  type TenantContext,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { ResolvedScope, ResolveScopeInput, TenancyContract } from '../contract.js';
import type { AcademicYear, Campus, Tenant } from '../domain/types.js';
import { toAcademicYear, toCampus } from '../infrastructure/mappers.js';
import { academicYearTable, campusTable } from '../infrastructure/schema.js';
import { AcademicYearService } from './academic-year.service.js';
import { CampusService } from './campus.service.js';
import { TenantService } from './tenant.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Implements `TenancyContract`. `getTenant`/`listCampuses`/etc. delegate to
 * the CRUD services (which read the ambient tenant context - see
 * `current-context.ts`). `resolveScope` is the exception: it is what
 * *establishes* that ambient context in the first place (called by
 * `TenantContextInterceptor` in `apps/api` before anything downstream has a
 * tenant to be ambient about), so it takes its tenant explicitly instead.
 */
@Injectable()
export class TenancyService implements TenancyContract {
  constructor(
    @Inject(TenantService) private readonly tenants: TenantService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(AcademicYearService) private readonly academicYears: AcademicYearService,
  ) {}

  getTenant(id: TenantId): Promise<Result<Tenant, NotFoundError>> {
    return this.tenants.getById(id);
  }

  getTenantBySlug(slug: string): Promise<Result<Tenant, NotFoundError>> {
    return this.tenants.getBySlug(slug);
  }

  listCampuses(): Promise<Campus[]> {
    return this.campuses.list();
  }

  getCampus(id: CampusId): Promise<Result<Campus, NotFoundError>> {
    return this.campuses.getById(id);
  }

  listAcademicYears(): Promise<AcademicYear[]> {
    return this.academicYears.list();
  }

  getCurrentAcademicYear(): Promise<Result<AcademicYear, NotFoundError>> {
    return this.academicYears.getCurrent();
  }

  async resolveScope(input: ResolveScopeInput): Promise<Result<ResolvedScope, DomainError>> {
    const tenantResult = UUID_PATTERN.test(input.tenantSlugOrId)
      ? await this.tenants.getById(input.tenantSlugOrId as TenantId)
      : await this.tenants.getBySlug(input.tenantSlugOrId);

    if (!tenantResult.ok) {
      return err(new ForbiddenError(`Unknown tenant: "${input.tenantSlugOrId}".`));
    }
    const tenant = tenantResult.value;

    // A fresh, minimal tenant context scoped to exactly the tenant we just
    // confirmed exists. Everything below runs through withTenantTx with
    // this context, so RLS - not application-level filtering - is what
    // proves a supplied campus/academic-year id belongs to this tenant: a
    // foreign id simply is not visible and the query returns no row.
    const ctx: TenantContext = { tenantId: tenant.id, roles: [], requestId: newId() };

    const [campusResult, academicYearResult] = await Promise.all([
      this.resolveCampusId(ctx, input.campusId),
      this.resolveAcademicYearId(ctx, input.academicYearId),
    ]);

    if (!campusResult.ok) {
      return err(campusResult.error);
    }
    if (!academicYearResult.ok) {
      return err(academicYearResult.error);
    }

    return ok({
      tenantId: tenant.id,
      ...(campusResult.value !== undefined ? { campusId: campusResult.value } : {}),
      ...(academicYearResult.value !== undefined ? { academicYearId: academicYearResult.value } : {}),
    });
  }

  /** Verifies a supplied campus id belongs to `ctx`'s tenant, or falls back to the tenant's default campus. */
  private async resolveCampusId(
    ctx: TenantContext,
    campusId: string | undefined,
  ): Promise<Result<CampusId | undefined, ForbiddenError>> {
    if (campusId === undefined) {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .select()
          .from(campusTable)
          .where(and(eq(campusTable.tenantId, ctx.tenantId), eq(campusTable.isDefault, true)))
          .limit(1),
      );
      return ok(rows[0] ? (toCampus(rows[0]).id as CampusId) : undefined);
    }

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(campusTable)
        .where(and(eq(campusTable.id, campusId), eq(campusTable.tenantId, ctx.tenantId)))
        .limit(1),
    );
    if (!rows[0]) {
      return err(new ForbiddenError(`Campus ${campusId} does not belong to tenant ${ctx.tenantId}.`));
    }
    return ok(toCampus(rows[0]).id as CampusId);
  }

  /** Verifies a supplied academic year id belongs to `ctx`'s tenant, or falls back to the tenant's current year. */
  private async resolveAcademicYearId(
    ctx: TenantContext,
    academicYearId: string | undefined,
  ): Promise<Result<AcademicYearId | undefined, ForbiddenError>> {
    if (academicYearId === undefined) {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .select()
          .from(academicYearTable)
          .where(and(eq(academicYearTable.tenantId, ctx.tenantId), eq(academicYearTable.isCurrent, true)))
          .limit(1),
      );
      return ok(rows[0] ? (toAcademicYear(rows[0]).id as AcademicYearId) : undefined);
    }

    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(academicYearTable)
        .where(and(eq(academicYearTable.id, academicYearId), eq(academicYearTable.tenantId, ctx.tenantId)))
        .limit(1),
    );
    if (!rows[0]) {
      return err(new ForbiddenError(`Academic year ${academicYearId} does not belong to tenant ${ctx.tenantId}.`));
    }
    return ok(toAcademicYear(rows[0]).id as AcademicYearId);
  }
}
