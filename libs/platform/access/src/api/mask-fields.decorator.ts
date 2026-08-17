import { SetMetadata } from '@nestjs/common';

export const MASK_FIELDS_RESOURCE_KEY = 'sms:maskFieldsResource';

/**
 * Tags a route's response as instances of `resource` (a `domain/field-
 * registry.ts` resource name, e.g. `people.student`), so
 * `FieldMaskingInterceptor` knows which registry entries apply to it. A
 * route with no `@MaskFields` is left untouched by the interceptor - it is
 * opt-in, exactly like `@RequirePermission`.
 */
export const MaskFields = (resource: string): MethodDecorator & ClassDecorator => SetMetadata(MASK_FIELDS_RESOURCE_KEY, resource);
