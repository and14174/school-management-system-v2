import type { MongoAbility, Subject } from '@casl/ability';

/**
 * `[action, subject]`: `action` is a permission's `action` (`read`,
 * `read_medical`, `manage`, ...); `subject` is either a bare resource-name
 * string (`people.student`, `access.role`, ...) - the same two halves that
 * make up a catalogue `key` (`resource:action`, joined by `permissionKey` in
 * `domain/permissions.ts`) - or `@casl/ability`'s broader `Subject` (a
 * tagged plain object, via its `subject()` helper: `subject('people.student',
 * record)`), for callers that have a concrete record to test `own`/`campus`
 * conditions against. Every rule this module ever builds (`AbilityService.
 * buildAbility`) uses a bare resource-name string as its `subject`, since
 * resources are dynamic (defined by the database catalogue - see the `0400`
 * migration), not fixed TS classes CASL can infer subject types from the
 * usual way.
 *
 * Checking `ability.can(action, resourceTypeString)` (no instance) is a
 * type-level check - CASL ignores any rule's conditions when the subject is
 * a bare string rather than a real object, which is exactly what
 * `PermissionGuard` and `FieldMaskingInterceptor` need before any concrete
 * record exists to test `own`/`campus` conditions against.
 */
export type AppAbility = MongoAbility<[string, Subject]>;
