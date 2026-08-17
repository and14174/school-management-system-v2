import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createMongoAbility, type RawRuleOf } from '@casl/ability';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { todayDateOnly, type CampusId, type DateOnly, type PersonId, type TenantId, type UserId } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { UNRESOLVABLE_SCOPES, type EffectivePermission, type ScopeConstraint } from '../domain/types.js';
import { permissionTable, roleAssignmentTable, rolePermissionTable } from '../infrastructure/schema.js';
import { toPermissionScope } from '../infrastructure/mappers.js';
import { AbilityCache } from './ability-cache.js';
import type { AppAbility } from './ability.types.js';
import { DEFAULT_SECTION_SCOPE_RESOLVER, SECTION_SCOPE_RESOLVER, type SectionScopeResolver } from './section-scope-resolver.js';
import { DEFAULT_DEPENDANT_SCOPE_RESOLVER, DEPENDANT_SCOPE_RESOLVER, type DependantScopeResolver } from './dependant-scope-resolver.js';
import { scopedContext } from './scoped-context.js';

interface CompiledGrant {
  readonly resource: string;
  readonly action: string;
  readonly scope: string;
  readonly campusId: CampusId | null;
}

/**
 * Compiles a CASL ability from `access.role_assignment` + `access.role_
 * permission` + `access.permission`, applying the scope condition each
 * grant's scope implies. This is the one place in the codebase that decides
 * what a scope actually means at runtime - see the `0400` migration header.
 * `grade_level` still never emits a rule (`UNRESOLVABLE_SCOPES`); `section`
 * emits one only when `sectionScopeResolver` resolves at least one section -
 * see `buildAbility`'s `'section'` case and `section-scope-resolver.ts`.
 * `dependants` is the same shape, one level down: it emits one only when
 * `dependantScopeResolver` resolves at least one child - see `buildAbility`'s
 * `'dependants'` case and `dependant-scope-resolver.ts`.
 */
@Injectable()
export class AbilityService {
  private readonly logger = new Logger(AbilityService.name);

  // Explicit @Inject(): under tsx/esbuild's decorator metadata emission,
  // implicit type-based DI is not trusted in this codebase - see
  // apps/api's HealthController for the fuller explanation.
  //
  // @Optional() on sectionScopeResolver/dependantScopeResolver, with a plain
  // ES6 default parameter value: nothing in THIS module registers
  // SECTION_SCOPE_RESOLVER or DEPENDANT_SCOPE_RESOLVER (see each port file's
  // own comment for why not) - only apps/api's AcademicModule (section) and
  // apps/api's own DependantScopeResolverModule (dependants) do, both as
  // @Global() providers. When nothing supplies one (no such module wired up;
  // a test that `new AbilityService(cache)`s this directly), Nest injects
  // `undefined` for an @Optional() token it cannot resolve, and the default
  // parameter value applies - the safe "resolves to nothing" default this
  // class's own compile() method depends on for section-/dependants-scoped
  // grants.
  constructor(
    @Inject(AbilityCache) private readonly cache: AbilityCache,
    @Optional()
    @Inject(SECTION_SCOPE_RESOLVER)
    private readonly sectionScopeResolver: SectionScopeResolver = DEFAULT_SECTION_SCOPE_RESOLVER,
    @Optional()
    @Inject(DEPENDANT_SCOPE_RESOLVER)
    private readonly dependantScopeResolver: DependantScopeResolver = DEFAULT_DEPENDANT_SCOPE_RESOLVER,
  ) {}

  async compileAbility(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<AppAbility> {
    const resolveDate = asOf ?? todayDateOnly();
    const isDefaultAsOf = asOf === undefined;

    if (isDefaultAsOf) {
      const cached = this.cache.get(tenantId, userId);
      if (cached) {
        return cached;
      }
    }

    const grants = await this.loadGrants(userId, tenantId, resolveDate);
    const ability = await this.buildAbility(tenantId, userId, grants);

    if (isDefaultAsOf) {
      this.cache.set(tenantId, userId, ability);
    }
    return ability;
  }

  invalidate(tenantId: TenantId, userId: UserId): void {
    this.cache.invalidate(tenantId, userId);
  }

  /** See `AbilityCache.invalidateTenant` - for changes to a ROLE's permissions. */
  invalidateTenant(tenantId: TenantId): void {
    this.cache.invalidateTenant(tenantId);
  }

  /** Loads every (permission, scope, campus) grant that `userId`'s currently-effective role assignments confer, in `tenantId`. */
  private async loadGrants(userId: UserId, tenantId: TenantId, asOf: DateOnly): Promise<CompiledGrant[]> {
    const ctx = scopedContext(tenantId);

    const assignments = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(roleAssignmentTable)
        .where(
          and(
            eq(roleAssignmentTable.tenantId, tenantId),
            eq(roleAssignmentTable.userId, userId),
            lte(roleAssignmentTable.validFrom, asOf),
            or(isNull(roleAssignmentTable.validTo), gte(roleAssignmentTable.validTo, asOf)),
          ),
        ),
    );

    if (assignments.length === 0) {
      return [];
    }

    const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];

    const rolePermissionRows = await withTenantTx(ctx, (db) =>
      db
        .select({
          roleId: rolePermissionTable.roleId,
          scope: rolePermissionTable.scope,
          permission: permissionTable,
        })
        .from(rolePermissionTable)
        .innerJoin(permissionTable, eq(rolePermissionTable.permissionId, permissionTable.id))
        .where(inArray(rolePermissionTable.roleId, roleIds)),
    );

    const grants: CompiledGrant[] = [];
    for (const assignment of assignments) {
      const campusId = (assignment.campusId as CampusId | null) ?? null;
      for (const row of rolePermissionRows) {
        if (row.roleId !== assignment.roleId) {
          continue;
        }
        grants.push({
          resource: row.permission.resource,
          action: row.permission.action,
          scope: row.scope,
          campusId,
        });
      }
    }
    return grants;
  }

  /** Every campus id belonging to `tenantId` - resolved via a direct query (see `application/schemas.ts`-style raw-sql precedent in `@sms/identity`'s `seed.ts`) rather than importing `@sms/tenancy`'s internal schema, which this package cannot reach past its public contract. */
  private async allCampusIds(tenantId: TenantId): Promise<CampusId[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<{ id: string }>(sql`select id from tenancy.campus where tenant_id = ${tenantId}`),
    );
    return (rows as unknown as Array<{ id: string }>).map((row) => row.id as CampusId);
  }

  /**
   * Builds rules directly (`createMongoAbility(rules)`) rather than through
   * `AbilityBuilder` - `AbilityBuilder<AppAbility>.can`'s generic signature
   * expects a real subject class (or tagged interface) to infer field types
   * for its `conditions` parameter from, which every rule this module builds
   * (subjects are plain resource-name strings, since no concrete resource
   * types exist yet - see `ability.types.ts`) cannot supply - fighting that
   * generic would need the same unsound casts either way.
   * `RawRuleOf<AppAbility>` is the exact shape `AbilityBuilder` itself
   * produces internally, so this is not a lesser-typed shortcut, just a more
   * direct route to it.
   */
  private async buildAbility(tenantId: TenantId, userId: UserId, grants: CompiledGrant[]): Promise<AppAbility> {
    const rules: RawRuleOf<AppAbility>[] = [];

    let allCampusIdsCache: CampusId[] | undefined;
    const resolveAllCampusIds = async (): Promise<CampusId[]> => {
      allCampusIdsCache ??= await this.allCampusIds(tenantId);
      return allCampusIdsCache;
    };

    for (const grant of grants) {
      const scope = toPermissionScope(grant.scope);

      if (UNRESOLVABLE_SCOPES.has(scope)) {
        // Fail closed: no rule emitted. The academic/enrollment modules that
        // would let this resolve to a real set of sections/grade levels
        // don't exist yet (M2) - see the 0400 migration header. Logged, not
        // silent, so an operator can see a grant exists but is inert.
        this.logger.warn(
          `Scope "${scope}" is unresolvable (no academic/enrollment module yet) - denying grant of ` +
            `"${grant.resource}:${grant.action}" to user ${userId} in tenant ${tenantId}.`,
        );
        continue;
      }

      switch (scope) {
        case 'tenant':
          rules.push({ action: grant.action, subject: grant.resource });
          break;
        case 'own':
          rules.push({ action: grant.action, subject: grant.resource, conditions: { userId } });
          break;
        case 'campus': {
          const campusIds = grant.campusId ? [grant.campusId] : await resolveAllCampusIds();
          rules.push({ action: grant.action, subject: grant.resource, conditions: { campusId: { $in: campusIds } } });
          break;
        }
        case 'section': {
          const sectionIds = await this.sectionScopeResolver.resolveTeachingSectionIds(userId, tenantId);
          if (sectionIds.length === 0) {
            // The resolver ran and found nothing (this user teaches no
            // section right now) - still no rule, for the exact same
            // fail-closed reason UNRESOLVABLE_SCOPES exists: an empty
            // resolver result must never be silently treated as
            // unrestricted, only as "nothing to grant yet".
            continue;
          }
          rules.push({ action: grant.action, subject: grant.resource, conditions: { sectionId: { $in: sectionIds } } });
          break;
        }
        case 'dependants': {
          const dependantPersonIds = await this.dependantScopeResolver.resolveDependantPersonIds(userId, tenantId);
          if (dependantPersonIds.length === 0) {
            // Same fail-closed posture as UNRESOLVABLE_SCOPES/'section' above:
            // a guardian with no (or not-yet-resolvable) children must not
            // see "everything" just because the resolver came back empty.
            // Logged (not silent) so an operator can see the grant exists but
            // is inert - same reason the UNRESOLVABLE_SCOPES branch logs.
            this.logger.warn(
              `Scope "dependants" resolved to zero dependants for user ${userId} in tenant ${tenantId} - denying grant of ` +
                `"${grant.resource}:${grant.action}".`,
            );
            continue;
          }
          rules.push({ action: grant.action, subject: grant.resource, conditions: { personId: { $in: dependantPersonIds } } });
          break;
        }
      }
    }

    return createMongoAbility(rules);
  }

  /** Every `identity.membership.person_id` belonging to `userId` in `tenantId` - same direct-query precedent as `allCampusIds` above (this package cannot import `@sms/identity`'s internal schema past its public contract). */
  private async resolvePersonId(userId: UserId, tenantId: TenantId): Promise<PersonId | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.execute<{ person_id: string | null }>(
        sql`select person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} limit 1`,
      ),
    );
    const row = (rows as unknown as Array<{ person_id: string | null }>)[0];
    return (row?.person_id as PersonId | undefined) ?? null;
  }

  /**
   * The data-filtering counterpart to `compileAbility` - see `ScopeConstraint`'s
   * own doc comment. Groups this user's currently-effective grants by
   * permission key (`resource:action`) and, for each, resolves the single
   * constraint that applies: `tenant` wins outright if held at all (no
   * further narrowing needed); otherwise `campus`/`section`/`own` resolve to
   * their concrete id set; anything else (today: only `grade_level`, still
   * in `UNRESOLVABLE_SCOPES`) resolves to `none` - the same fail-closed
   * default `compileAbility` applies, expressed in this layer's vocabulary.
   */
  async resolveScopeConstraints(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<Record<string, ScopeConstraint>> {
    const resolveDate = asOf ?? todayDateOnly();
    const grants = await this.loadGrants(userId, tenantId, resolveDate);

    const grantsByKey = new Map<string, CompiledGrant[]>();
    for (const grant of grants) {
      const key = `${grant.resource}:${grant.action}`;
      const list = grantsByKey.get(key) ?? [];
      list.push(grant);
      grantsByKey.set(key, list);
    }

    let allCampusIdsCache: CampusId[] | undefined;
    let sectionIdsCache: string[] | undefined;
    let dependantPersonIdsCache: PersonId[] | undefined;
    let personIdCache: PersonId | null | undefined;

    const result: Record<string, ScopeConstraint> = {};

    // Precedence, when a role holds the SAME permission key at more than one
    // scope: tenant > campus > section > dependants > own. Widest wins first
    // (tenant/campus/section, in that order of narrowing) and 'own' is
    // checked last because it is the narrowest of all - exactly one person,
    // never a set. 'dependants' sits between 'section' and 'own' rather than
    // colliding with either in practice: the Parent/Guardian role holds
    // `dependants` grants and the Student role holds `own` grants for the
    // same permission keys, but no SEEDED role holds both at once - so this
    // ordering documents intent for a hypothetical future role without ever
    // having silently dropped access a real role relies on today.
    for (const [key, keyGrants] of grantsByKey) {
      const scopes = keyGrants.map((grant) => toPermissionScope(grant.scope));

      if (scopes.includes('tenant')) {
        result[key] = { kind: 'tenant' };
        continue;
      }

      if (scopes.includes('campus')) {
        const explicitCampusIds: CampusId[] = [];
        for (const grant of keyGrants) {
          if (toPermissionScope(grant.scope) === 'campus' && grant.campusId) {
            explicitCampusIds.push(grant.campusId);
          }
        }
        const campusIds =
          explicitCampusIds.length > 0 ? explicitCampusIds : (allCampusIdsCache ??= await this.allCampusIds(tenantId));
        result[key] = { kind: 'campus', campusIds };
        continue;
      }

      if (scopes.includes('section')) {
        sectionIdsCache ??= await this.sectionScopeResolver.resolveTeachingSectionIds(userId, tenantId, resolveDate);
        result[key] = sectionIdsCache.length > 0 ? { kind: 'section', sectionIds: sectionIdsCache } : { kind: 'none' };
        continue;
      }

      if (scopes.includes('dependants')) {
        dependantPersonIdsCache ??= await this.dependantScopeResolver.resolveDependantPersonIds(userId, tenantId, resolveDate);
        result[key] = dependantPersonIdsCache.length > 0 ? { kind: 'dependants', personIds: dependantPersonIdsCache } : { kind: 'none' };
        continue;
      }

      if (scopes.includes('own')) {
        if (personIdCache === undefined) {
          personIdCache = await this.resolvePersonId(userId, tenantId);
        }
        result[key] = { kind: 'own', personId: personIdCache };
        continue;
      }

      // grade_level, or any future scope with no resolver yet.
      result[key] = { kind: 'none' };
    }

    return result;
  }

  /** Flattens a compiled ability's rules back into a list of (key, resource, action, scope) - what `GET /access/me` reports. Reconstructed from the same grants `compileAbility` used, not from the built ability's internal rule representation, so the reported scope is the same value the database holds. */
  async listEffectivePermissions(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<EffectivePermission[]> {
    const resolveDate = asOf ?? todayDateOnly();
    const grants = await this.loadGrants(userId, tenantId, resolveDate);

    const seen = new Set<string>();
    const result: EffectivePermission[] = [];
    for (const grant of grants) {
      const scope = toPermissionScope(grant.scope);
      const key = `${grant.resource}:${grant.action}:${scope}`;
      if (seen.has(key) || UNRESOLVABLE_SCOPES.has(scope)) {
        continue;
      }
      seen.add(key);
      result.push({ key: `${grant.resource}:${grant.action}`, resource: grant.resource, action: grant.action, scope });
    }
    return result;
  }
}
