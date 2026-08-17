import type { AcademicYearId, CampusId, DomainError, NotFoundError, Result, TenantId } from '@sms/kernel';
import type { AcademicYear, Campus, Tenant } from './domain/types.js';

export * from './domain/types.js';

/** Raw input to `resolveScope` - everything here is caller/header-supplied and untrusted until validated against the database. */
export interface ResolveScopeInput {
  readonly tenantSlugOrId: string;
  readonly campusId?: string;
  readonly academicYearId?: string;
}

/**
 * The validated result of `resolveScope`: a tenant id that is known to
 * exist, plus a campus/academic-year id that are each either omitted
 * (nothing requested and no sensible default exists) or confirmed to belong
 * to that exact tenant. Nothing downstream needs to re-check this - that is
 * the entire point of centralising the check here.
 */
export interface ResolvedScope {
  readonly tenantId: TenantId;
  readonly campusId?: CampusId;
  readonly academicYearId?: AcademicYearId;
}

/**
 * The public port this module exposes to the rest of the system (REST
 * controllers in `src/api`, and - via the `TENANCY_CONTRACT` DI token -
 * `apps/api`'s `TenantContextInterceptor`, which calls `resolveScope` for
 * every request). Every other module that needs to know about tenants,
 * campuses or academic years should depend on this interface, not on the
 * concrete application services behind it.
 */
export interface TenancyContract {
  getTenant(id: TenantId): Promise<Result<Tenant, NotFoundError>>;
  getTenantBySlug(slug: string): Promise<Result<Tenant, NotFoundError>>;
  listCampuses(): Promise<Campus[]>;
  getCampus(id: CampusId): Promise<Result<Campus, NotFoundError>>;
  listAcademicYears(): Promise<AcademicYear[]>;
  getCurrentAcademicYear(): Promise<Result<AcademicYear, NotFoundError>>;
  /**
   * Validates a (tenant, campus?, academic-year?) triple end to end against
   * the database and returns a scope that is safe to trust for the rest of
   * the request. Rejects (with a `ForbiddenError`, a `DomainError`) an
   * unknown tenant, or a campus/academic-year id that does not belong to
   * the named tenant - this is what stops a caller pointing at another
   * school's campus.
   */
  resolveScope(input: ResolveScopeInput): Promise<Result<ResolvedScope, DomainError>>;
}

/**
 * DI token for `TenancyContract`. Interfaces don't exist at runtime, so
 * NestJS needs a concrete token to bind `TenancyService` to; consumers
 * inject with `@Inject(TENANCY_CONTRACT)` rather than relying on
 * implicit type-based DI, which is unreliable here for the same reason
 * documented on `apps/api`'s `HealthController` - esbuild/tsx's
 * `emitDecoratorMetadata` output does not survive across package
 * boundaries reliably enough to trust.
 */
export const TENANCY_CONTRACT = Symbol('TENANCY_CONTRACT');
