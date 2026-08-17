import { Module } from '@nestjs/common';
import { TenancyModule } from '@sms/tenancy';
import { IDENTITY_CONTRACT } from '../contract.js';
import { IdentityService } from '../application/identity.service.js';
import { MembershipService } from '../application/membership.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';

/**
 * Exports `IDENTITY_CONTRACT` (not the concrete `IdentityService`), plus
 * `MembershipService` and `AuthGuard` directly - matching `@sms/tenancy`'s
 * `TenancyModule` shape. `apps/api`'s `AppModule` needs this imported both
 * for `AuthController` and because it registers `AuthGuard` globally
 * (`APP_GUARD`), whose constructor depends on `IDENTITY_CONTRACT` and
 * `MembershipService` - Nest resolves a global provider's dependencies from
 * the module it's registered in, so those tokens must be visible there.
 *
 * Imports `TenancyModule` (not just depends on `@sms/tenancy`'s contract
 * types): `AuthController.me()` reads the active tenant's name/slug via
 * `TENANCY_CONTRACT`, which only exists in the DI container once
 * `TenancyModule` is imported somewhere reachable from this one.
 */
@Module({
  imports: [TenancyModule],
  controllers: [AuthController],
  providers: [
    MembershipService,
    IdentityService,
    { provide: IDENTITY_CONTRACT, useExisting: IdentityService },
    AuthGuard,
  ],
  exports: [IDENTITY_CONTRACT, MembershipService, AuthGuard],
})
export class IdentityModule {}
