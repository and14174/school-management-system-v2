import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ForbiddenError, isSystemContext, unwrap } from '@sms/kernel';
import { requireContext } from '@sms/db';
import { TENANCY_CONTRACT, type TenancyContract } from '../contract.js';

/**
 * Feeds the web app's scope switcher: the resolved tenant, every campus and
 * academic year it could switch to, and which one is currently active. The
 * "currently active" part is exactly what `TenantContextInterceptor`
 * resolved (and database-validated, via `resolveScope`) for this request -
 * this endpoint does not re-resolve anything, it just reports it back
 * alongside the full lists to populate a picker.
 */
@ApiTags('tenancy')
@Controller('tenancy')
export class ScopeController {
  // Explicit @Inject(): see apps/api's HealthController for why implicit
  // type-based DI is not trusted in this codebase.
  constructor(@Inject(TENANCY_CONTRACT) private readonly tenancy: TenancyContract) {}

  @Get('scope')
  async getScope() {
    const ctx = requireContext();
    if (isSystemContext(ctx)) {
      throw new ForbiddenError('No tenant is resolved for this request (missing x-tenant-id).');
    }

    const [tenantResult, campuses, academicYears] = await Promise.all([
      this.tenancy.getTenant(ctx.tenantId),
      this.tenancy.listCampuses(),
      this.tenancy.listAcademicYears(),
    ]);
    const tenant = unwrap(tenantResult);

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      campuses: campuses.map((campus) => ({
        id: campus.id,
        code: campus.code,
        name: campus.name,
        isDefault: campus.isDefault,
        status: campus.status,
      })),
      academicYears: academicYears.map((year) => ({
        id: year.id,
        name: year.name,
        startsOn: year.startsOn,
        endsOn: year.endsOn,
        status: year.status,
        isCurrent: year.isCurrent,
      })),
      current: {
        campusId: ctx.campusId ?? null,
        academicYearId: ctx.academicYearId ?? null,
      },
    };
  }
}
