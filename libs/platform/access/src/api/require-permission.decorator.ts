import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'sms:requiredPermission';

/**
 * Gates a route (or an entire controller) behind a permission catalogue key
 * (`resource:action`, e.g. `people.student:read_medical`) - checked by
 * `PermissionGuard`, which reads this metadata with `Reflect.getMetadata`
 * exactly like `@sms/identity`'s `AuthGuard` reads `@Public()`'s (see that
 * guard's own comment for why: not `Reflector` injection). A route with no
 * `@RequirePermission` at all is left alone by `PermissionGuard` - it is
 * opt-in, not a second global deny-by-default gate on top of `AuthGuard`.
 */
export const RequirePermission = (key: string): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_PERMISSION_KEY, key);
