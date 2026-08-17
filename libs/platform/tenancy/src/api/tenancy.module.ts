import { Module } from '@nestjs/common';
import { TENANCY_CONTRACT } from '../contract.js';
import { AcademicYearService } from '../application/academic-year.service.js';
import { CampusService } from '../application/campus.service.js';
import { TenancyService } from '../application/tenancy.service.js';
import { TenantService } from '../application/tenant.service.js';
import { AcademicYearsController } from './academic-years.controller.js';
import { CampusesController } from './campuses.controller.js';
import { ScopeController } from './scope.controller.js';

/**
 * Exports `TENANCY_CONTRACT` (not the concrete `TenancyService`) so
 * consumers - including `apps/api`'s `TenantContextInterceptor`, which is
 * itself a global `APP_INTERCEPTOR` registered in `AppModule` and therefore
 * needs this module imported there - depend on the interface, matching the
 * DI-token convention documented on `TENANCY_CONTRACT` in `contract.ts`.
 */
@Module({
  controllers: [ScopeController, CampusesController, AcademicYearsController],
  providers: [
    TenantService,
    CampusService,
    AcademicYearService,
    TenancyService,
    { provide: TENANCY_CONTRACT, useExisting: TenancyService },
  ],
  exports: [TENANCY_CONTRACT, TenantService, CampusService, AcademicYearService],
})
export class TenancyModule {}
