// The public surface other modules should depend on: the port
// (`PublicApiContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs: an actual NestJS module class to wire up
// (`PublicApiModule`) and the guard registered as a global `APP_GUARD` in
// `AppModule` - see each file's own comment for why these can't just live
// behind the contract interface (same reasoning as `@sms/identity`'s
// index.ts).
export { PublicApiModule } from './api/public-api.module.js';
export { ApiKeyGuard } from './api/api-key-auth.guard.js';
export { RATE_LIMITER, RedisRateLimiter, type RateLimiter, type RateLimitResult } from './application/rate-limiter.js';
export {
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
  resetKeyMaterialCacheForTests,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './application/key-material.js';
