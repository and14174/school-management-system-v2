// The public surface other modules should depend on: the port
// (`AccessContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs: an actual NestJS module class to wire up
// (`AccessModule`), the guard + interceptor registered globally in
// `AppModule`, the decorators routes use to opt into them, and the field
// registry the masking interceptor is driven by - see each file's own
// comment for why these can't just live behind the contract interface
// (same reasoning as `@sms/identity`'s index.ts).
export { AccessModule } from './api/access.module.js';
export { PermissionGuard } from './api/permission.guard.js';
export { RequirePermission, REQUIRE_PERMISSION_KEY } from './api/require-permission.decorator.js';
export { FieldMaskingInterceptor, maskFields, maskResponse } from './api/field-masking.interceptor.js';
export { MaskFields, MASK_FIELDS_RESOURCE_KEY } from './api/mask-fields.decorator.js';
export { FIELD_REGISTRY, fieldRegistryFor, unknownPermissionsInFieldRegistry, type FieldRegistryEntry } from './domain/field-registry.js';
export { PERMISSION_CATALOGUE, PERMISSION_DEFINITIONS, isKnownPermission, permissionKey, type PermissionDefinition } from './domain/permissions.js';
