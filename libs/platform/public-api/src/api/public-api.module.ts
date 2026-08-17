import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { PUBLIC_API_CONTRACT } from '../contract.js';
import { ApiKeysService } from '../application/api-keys.service.js';
import { RATE_LIMITER, RedisRateLimiter } from '../application/rate-limiter.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeyGuard } from './api-key-auth.guard.js';

/**
 * Exports `PUBLIC_API_CONTRACT` and `RATE_LIMITER` (not the concrete
 * classes) plus `ApiKeyGuard` directly - matching `@sms/access`'s
 * `AccessModule` shape: `apps/api`'s `AppModule` needs `ApiKeyGuard`
 * registered as a global `APP_GUARD`, whose constructor depends on both
 * tokens - Nest resolves a global provider's dependencies from the module
 * it's registered in, so both must be visible there (see `AccessModule`'s
 * own comment for the identical reasoning).
 *
 * Imports `AccessModule`: `ApiKeysService.mint` checks the granted-permission
 * subset via `ACCESS_CONTRACT.listEffectivePermissions`, and
 * `ApiKeysController` is gated with `@RequirePermission`.
 */
@Module({
  imports: [AccessModule],
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    { provide: PUBLIC_API_CONTRACT, useExisting: ApiKeysService },
    { provide: RATE_LIMITER, useClass: RedisRateLimiter },
    ApiKeyGuard,
  ],
  exports: [PUBLIC_API_CONTRACT, RATE_LIMITER, ApiKeyGuard],
})
export class PublicApiModule {}
