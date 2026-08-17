import { Module } from '@nestjs/common';
import { IdentityModule } from '@sms/identity';
import { ACCESS_CONTRACT } from '../contract.js';
import { AbilityCache } from '../application/ability-cache.js';
import { AbilityService } from '../application/ability.service.js';
import { AccessService } from '../application/access.service.js';
import { ImpersonationService } from '../application/impersonation.service.js';
import { RoleService } from '../application/role.service.js';
import { FieldMaskingInterceptor } from './field-masking.interceptor.js';
import { ImpersonationController } from './impersonation.controller.js';
import { MeController } from './me.controller.js';
import { PermissionGuard } from './permission.guard.js';
import { RolesController } from './roles.controller.js';

/**
 * Exports `ACCESS_CONTRACT` (not the concrete `AccessService`), plus
 * `PermissionGuard` and `FieldMaskingInterceptor` directly - matching
 * `@sms/identity`'s `IdentityModule` shape: `apps/api`'s `AppModule` needs
 * `PermissionGuard` and `FieldMaskingInterceptor` registered as global
 * `APP_GUARD`/`APP_INTERCEPTOR` providers, whose constructors depend on
 * `ACCESS_CONTRACT` - Nest resolves a global provider's dependencies from
 * the module it's registered in, so that token must be visible there.
 *
 * Imports `IdentityModule`: `ImpersonationService` looks up the
 * impersonation target via `IDENTITY_CONTRACT`, which only exists in the DI
 * container once `IdentityModule` is imported somewhere reachable from this
 * one.
 */
@Module({
  imports: [IdentityModule],
  controllers: [RolesController, MeController, ImpersonationController],
  providers: [
    AbilityCache,
    AbilityService,
    RoleService,
    ImpersonationService,
    AccessService,
    { provide: ACCESS_CONTRACT, useExisting: AccessService },
    PermissionGuard,
    FieldMaskingInterceptor,
  ],
  exports: [ACCESS_CONTRACT, AbilityService, RoleService, PermissionGuard, FieldMaskingInterceptor],
})
export class AccessModule {}
