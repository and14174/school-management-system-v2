import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'sms:isPublic';

/**
 * Opts a route (or an entire controller) out of `AuthGuard`, which is
 * registered as a global `APP_GUARD` in `apps/api`'s `AppModule` and
 * therefore runs before every request by default. Use on health checks, the
 * Swagger docs, and the Better Auth routes themselves (which authenticate
 * the request in their own way - that is the whole point of them).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
