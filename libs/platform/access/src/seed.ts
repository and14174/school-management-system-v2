#!/usr/bin/env tsx
/**
 * Idempotent local-dev/CI seed data: the full permission catalogue (from
 * `src/domain/permissions.ts`, the source of truth - see the `0400`
 * migration header), eight system roles with sensible scoped grants, and
 * `School Administrator` assigned to `admin@greenwood.test`.
 *
 * Complements (does not modify - see the module report's constraints)
 * `@sms/tenancy`'s and `@sms/identity`'s own `seed.ts`: both must have
 * already run (this script looks up the "greenwood" tenant and the admin
 * user, and fails with a clear message if either is missing, rather than
 * creating a divergent one).
 *
 * Usage: tsx src/seed.ts (run after @sms/tenancy's and @sms/identity's).
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import { newId, type TenantId, type UserId } from '@sms/kernel';
import { PERMISSION_CATALOGUE } from './domain/permissions.js';
import type { PermissionScope } from './domain/types.js';
import { AbilityCache } from './application/ability-cache.js';
import { AbilityService } from './application/ability.service.js';
import { RoleService } from './application/role.service.js';
import { getAccessDb } from './infrastructure/db.js';
import { permissionTable } from './infrastructure/schema.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// Resolved relative to this file, not process.cwd() - see @sms/tenancy's migrate.ts/seed.ts for why.
try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // no .env file present - assume the environment already has what we need
}

const ADMIN_EMAIL = 'admin@greenwood.test';

interface SeedRoleGrant {
  readonly permissionKey: string;
  readonly scope: PermissionScope;
}

interface SeedRole {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly grants: SeedRoleGrant[];
}

const SEED_ROLES: SeedRole[] = [
  {
    key: 'school_administrator',
    name: 'School Administrator',
    description: 'Full administrative access across the tenant.',
    grants: [
      { permissionKey: 'access.role:read', scope: 'tenant' },
      { permissionKey: 'access.role:manage', scope: 'tenant' },
      { permissionKey: 'access.impersonation:create', scope: 'tenant' },
      { permissionKey: 'people.person:read', scope: 'tenant' },
      { permissionKey: 'people.person:write', scope: 'tenant' },
      { permissionKey: 'people.person:merge', scope: 'tenant' },
      { permissionKey: 'people.student:read', scope: 'tenant' },
      { permissionKey: 'people.student:write', scope: 'tenant' },
      { permissionKey: 'people.student:read_medical', scope: 'tenant' },
      { permissionKey: 'people.student:read_safeguarding', scope: 'tenant' },
      { permissionKey: 'people.staff:read', scope: 'tenant' },
      { permissionKey: 'academic.gradebook:read', scope: 'tenant' },
      { permissionKey: 'academic.gradebook:write', scope: 'tenant' },
      { permissionKey: 'billing.invoice:read', scope: 'tenant' },
      { permissionKey: 'billing.invoice:write', scope: 'tenant' },
      { permissionKey: 'billing.fee_schedule:manage', scope: 'tenant' },
      { permissionKey: 'billing.payment:record', scope: 'tenant' },
      { permissionKey: 'billing.credit_note:issue', scope: 'tenant' },
      { permissionKey: 'admissions.application:read', scope: 'tenant' },
      { permissionKey: 'admissions.application:write', scope: 'tenant' },
      { permissionKey: 'admissions.application:decide', scope: 'tenant' },
      { permissionKey: 'academic.term:read', scope: 'tenant' },
      { permissionKey: 'academic.term:write', scope: 'tenant' },
      { permissionKey: 'academic.grade_level:read', scope: 'tenant' },
      { permissionKey: 'academic.grade_level:write', scope: 'tenant' },
      { permissionKey: 'academic.department:read', scope: 'tenant' },
      { permissionKey: 'academic.department:write', scope: 'tenant' },
      { permissionKey: 'academic.subject:read', scope: 'tenant' },
      { permissionKey: 'academic.subject:write', scope: 'tenant' },
      { permissionKey: 'academic.course:read', scope: 'tenant' },
      { permissionKey: 'academic.course:write', scope: 'tenant' },
      { permissionKey: 'academic.room:read', scope: 'tenant' },
      { permissionKey: 'academic.room:write', scope: 'tenant' },
      { permissionKey: 'academic.section:read', scope: 'tenant' },
      { permissionKey: 'academic.section:write', scope: 'tenant' },
      { permissionKey: 'academic.section_roster:manage', scope: 'tenant' },
      { permissionKey: 'academic.timetable:read', scope: 'tenant' },
      { permissionKey: 'academic.timetable:write', scope: 'tenant' },
      { permissionKey: 'enrollment.enrollment:read', scope: 'tenant' },
      { permissionKey: 'enrollment.enrollment:write', scope: 'tenant' },
      { permissionKey: 'enrollment.rollover:run', scope: 'tenant' },
      { permissionKey: 'attendance.record:read', scope: 'tenant' },
      { permissionKey: 'attendance.record:write', scope: 'tenant' },
      { permissionKey: 'attendance.correction:approve', scope: 'tenant' },
      { permissionKey: 'attendance.code:manage', scope: 'tenant' },
      { permissionKey: 'gradebook.scale:manage', scope: 'tenant' },
      { permissionKey: 'documents.document:read', scope: 'tenant' },
      { permissionKey: 'documents.document:generate', scope: 'tenant' },
      { permissionKey: 'documents.template:manage', scope: 'tenant' },
      { permissionKey: 'gradebook.grade:approve', scope: 'tenant' },
      // Report cards/transcripts/GPA/promotion eligibility - full reach,
      // same posture as every other tenant-wide grant on this role.
      { permissionKey: 'records.transcript:read', scope: 'tenant' },
      { permissionKey: 'records.transcript:finalise', scope: 'tenant' },
      // Notification template copy, delivery auditing, and every guardian's
      // preferences, tenant-wide - same reach as everything else on this role.
      { permissionKey: 'notifications.template:manage', scope: 'tenant' },
      { permissionKey: 'notifications.delivery:read', scope: 'tenant' },
      { permissionKey: 'notifications.preference:manage', scope: 'tenant' },
      // Minting machine credentials, and configuring who approves what, are
      // both administrator-only - neither is delegated to Registrar or Finance.
      { permissionKey: 'api.key:read', scope: 'tenant' },
      { permissionKey: 'api.key:manage', scope: 'tenant' },
      { permissionKey: 'approvals.policy:manage', scope: 'tenant' },
      { permissionKey: 'approvals.request:read', scope: 'tenant' },
    ],
  },
  {
    key: 'registrar',
    name: 'Registrar',
    description: 'Manages student records and admissions.',
    grants: [
      { permissionKey: 'access.role:read', scope: 'tenant' },
      { permissionKey: 'people.person:read', scope: 'tenant' },
      { permissionKey: 'people.person:write', scope: 'tenant' },
      { permissionKey: 'people.student:read', scope: 'tenant' },
      { permissionKey: 'people.student:write', scope: 'tenant' },
      { permissionKey: 'people.staff:read', scope: 'tenant' },
      { permissionKey: 'admissions.application:read', scope: 'tenant' },
      { permissionKey: 'admissions.application:write', scope: 'tenant' },
      { permissionKey: 'admissions.application:decide', scope: 'tenant' },
      { permissionKey: 'academic.term:read', scope: 'tenant' },
      { permissionKey: 'academic.grade_level:read', scope: 'tenant' },
      { permissionKey: 'academic.department:read', scope: 'tenant' },
      { permissionKey: 'academic.subject:read', scope: 'tenant' },
      { permissionKey: 'academic.course:read', scope: 'tenant' },
      { permissionKey: 'academic.room:read', scope: 'tenant' },
      { permissionKey: 'academic.section:read', scope: 'tenant' },
      { permissionKey: 'academic.section_roster:manage', scope: 'tenant' },
      { permissionKey: 'academic.timetable:read', scope: 'tenant' },
      { permissionKey: 'academic.timetable:write', scope: 'tenant' },
      { permissionKey: 'enrollment.enrollment:read', scope: 'tenant' },
      { permissionKey: 'enrollment.enrollment:write', scope: 'tenant' },
      { permissionKey: 'enrollment.rollover:run', scope: 'tenant' },
      { permissionKey: 'attendance.record:read', scope: 'tenant' },
      { permissionKey: 'attendance.record:write', scope: 'tenant' },
      { permissionKey: 'attendance.correction:approve', scope: 'tenant' },
      { permissionKey: 'attendance.code:manage', scope: 'tenant' },
      // Report-card oversight, tenant-wide - registrar is the school's
      // record-of-truth for grades, same reach it already has for
      // attendance corrections above.
      { permissionKey: 'academic.gradebook:read', scope: 'tenant' },
      { permissionKey: 'academic.gradebook:write', scope: 'tenant' },
      { permissionKey: 'gradebook.scale:manage', scope: 'tenant' },
      { permissionKey: 'gradebook.grade:approve', scope: 'tenant' },
      // Registrar is the school's record-of-truth for report cards and
      // transcripts too - the registrar issues them, same reach it already
      // has over grades above.
      { permissionKey: 'documents.document:read', scope: 'tenant' },
      { permissionKey: 'documents.document:generate', scope: 'tenant' },
      { permissionKey: 'documents.template:manage', scope: 'tenant' },
      { permissionKey: 'records.transcript:read', scope: 'tenant' },
      { permissionKey: 'records.transcript:finalise', scope: 'tenant' },
      // Same reach as School Administrator - the registrar is who a school
      // actually asks "did that parent get told?".
      { permissionKey: 'notifications.template:manage', scope: 'tenant' },
      { permissionKey: 'notifications.delivery:read', scope: 'tenant' },
      { permissionKey: 'notifications.preference:manage', scope: 'tenant' },
    ],
  },
  {
    key: 'teacher',
    name: 'Teacher',
    description: 'Views the students in their own sections and manages their grades.',
    // Deliberately `section`, not `campus`. Until @sms/academic landed and
    // implemented @sms/access's SECTION_SCOPE_RESOLVER port, `section` could
    // not be resolved at all, so this role granted NOTHING - a teacher
    // signing in saw no students and no gradebook. That was the correct
    // interim outcome: widening these to `campus` would have made the role
    // appear to work while giving every teacher permission to edit any
    // student's grades anywhere on their campus - a real over-permission
    // that, because it "works", nothing would ever prompt anyone to narrow.
    //
    // Now that the resolver is real (apps/api wires @sms/academic's
    // SectionScopeResolverService in as SECTION_SCOPE_RESOLVER - see
    // AbilityService.buildAbility's `'section'` case), a teacher with a
    // current `academic.section_teacher` row sees exactly the students and
    // sections THEY teach, and nothing else - the scope this role was always
    // meant to have, now actually enforced instead of merely declared.
    // `academic.section:read` (added alongside the pre-existing
    // `people.student:read`/`academic.gradebook:*`) lets a teacher see their
    // own sections' structure (course, term, roster size), not just the
    // people in them.
    grants: [
      { permissionKey: 'people.student:read', scope: 'section' },
      { permissionKey: 'academic.section:read', scope: 'section' },
      // Structural, non-sensitive, and tenant-wide on purpose: a teacher needs
      // to see which term and grading period their own sections belong to.
      // Without it the gradebook could not name the period it was showing and
      // had to infer a label from assignment due dates. `academic.term` covers
      // grading periods too (see its catalogue description) - the school
      // calendar describes the school, not any student.
      { permissionKey: 'academic.term:read', scope: 'tenant' },
      { permissionKey: 'academic.gradebook:read', scope: 'section' },
      { permissionKey: 'academic.gradebook:write', scope: 'section' },
      { permissionKey: 'academic.timetable:read', scope: 'section' },
      // Attendance is the screen a teacher touches every day: roster/mark/
      // summary/unmarked-sessions, scoped to exactly the sections they teach
      // (resolved by the same SECTION_SCOPE_RESOLVER as the grants above).
      // Deliberately NO attendance.correction:approve - a teacher must not
      // approve their own correction (see @sms/attendance's module report).
      { permissionKey: 'attendance.record:read', scope: 'section' },
      { permissionKey: 'attendance.record:write', scope: 'section' },
      // Report cards/transcripts for their own students, read only - a
      // teacher may look up what was issued or finalised, never issue or
      // finalise it themselves (documents.document:generate and
      // records.transcript:finalise are deliberately absent from this role -
      // see @sms/records' module report).
      { permissionKey: 'documents.document:read', scope: 'section' },
      { permissionKey: 'records.transcript:read', scope: 'section' },
    ],
  },
  {
    key: 'parent_guardian',
    name: 'Parent/Guardian',
    description: "Views their own children's records.",
    // 'dependants' (not 'own'): 'own' resolves to exactly the acting person,
    // which cannot express "a parent may read their own CHILD's record" - the
    // guardian's login and the child's people.person row are two different
    // people. 'dependants' is the scope built for exactly this: it resolves
    // (via @sms/access's DEPENDANT_SCOPE_RESOLVER port, apps/api's real
    // implementation) to every person this guardian has a parent/guardian
    // relationship TO - see application/dependant-scope-resolver.ts and
    // apps/api's DependantScopeResolverModule.
    grants: [
      { permissionKey: 'people.student:read', scope: 'dependants' },
      { permissionKey: 'attendance.record:read', scope: 'dependants' },
      { permissionKey: 'academic.gradebook:read', scope: 'dependants' },
      { permissionKey: 'records.transcript:read', scope: 'dependants' },
      { permissionKey: 'academic.timetable:read', scope: 'dependants' },
      { permissionKey: 'documents.document:read', scope: 'dependants' },
      // "All children, all fees, in one place" is the parent portal's whole
      // premise - a guardian sees what they owe for their OWN children and
      // nobody else's. Read-only: paying is not a Phase 1 flow, and a parent
      // must never be able to alter what they were charged.
      { permissionKey: 'billing.invoice:read', scope: 'dependants' },
      // A guardian manages THEIR OWN notification preferences (opt out of a
      // channel/category) - never their child's. Deliberately stays 'own',
      // not 'dependants': a mailing preference is a property of the person
      // being contacted (the guardian), not of the child the grant above
      // otherwise gives them read access to. 'own' resolves against the
      // person id linked to the guardian's own login - see
      // NotificationsController.assertCanManagePreferences.
      { permissionKey: 'notifications.preference:manage', scope: 'own' },
    ],
  },
  {
    key: 'student',
    name: 'Student',
    description: 'Views their own record.',
    grants: [
      { permissionKey: 'people.student:read', scope: 'own' },
      { permissionKey: 'attendance.record:read', scope: 'own' },
      { permissionKey: 'academic.gradebook:read', scope: 'own' },
      { permissionKey: 'records.transcript:read', scope: 'own' },
      { permissionKey: 'academic.timetable:read', scope: 'own' },
      { permissionKey: 'documents.document:read', scope: 'own' },
      { permissionKey: 'notifications.preference:manage', scope: 'own' },
    ],
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Manages billing and invoices tenant-wide.',
    grants: [
      { permissionKey: 'billing.invoice:read', scope: 'tenant' },
      { permissionKey: 'billing.invoice:write', scope: 'tenant' },
      { permissionKey: 'billing.fee_schedule:manage', scope: 'tenant' },
      { permissionKey: 'billing.payment:record', scope: 'tenant' },
      { permissionKey: 'billing.credit_note:issue', scope: 'tenant' },
      // Needed to know WHO an invoice is for. Without it the finance role can
      // read invoices but cannot resolve a single payer's name, which makes
      // every billing screen a list of anonymous ids.
      { permissionKey: 'people.person:read', scope: 'tenant' },
      { permissionKey: 'people.student:read', scope: 'tenant' },
    ],
  },
  {
    key: 'nurse',
    name: 'Nurse',
    description: "Views students' medical information at their campus. No grade access.",
    grants: [
      { permissionKey: 'people.student:read', scope: 'campus' },
      { permissionKey: 'people.student:read_medical', scope: 'campus' },
    ],
  },
  {
    key: 'counsellor',
    name: 'Counsellor',
    description: "Views students' safeguarding information at their campus. No grade access.",
    grants: [
      { permissionKey: 'people.student:read', scope: 'campus' },
      { permissionKey: 'people.student:read_safeguarding', scope: 'campus' },
    ],
  },
];

const roles = new RoleService(new AbilityService(new AbilityCache()));

async function findGreenwoodTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      'No tenant with slug "greenwood" found. Run @sms/tenancy\'s seed first: ' +
        '(cd libs/platform/tenancy && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as TenantId;
}

async function findAdminUserId(): Promise<UserId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from identity.user where email = ${ADMIN_EMAIL} limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error(
      `No user "${ADMIN_EMAIL}" found. Run @sms/identity's seed first: ` +
        '(cd libs/platform/identity && ../../../node_modules/.bin/tsx src/seed.ts)',
    );
  }
  return row.id as UserId;
}

/** Inserts every catalogue entry missing from `access.permission`, by `key`. `@global`, no tenant - see `infrastructure/db.ts`. */
async function seedPermissionCatalogue(): Promise<void> {
  for (const definition of PERMISSION_CATALOGUE) {
    const existing = await getAccessDb().select().from(permissionTable).where(eq(permissionTable.key, definition.key)).limit(1);
    if (existing[0]) {
      continue;
    }
    await getAccessDb()
      .insert(permissionTable)
      .values({
        id: newId(),
        key: definition.key,
        resource: definition.resource,
        action: definition.action,
        description: definition.description,
      });
    console.log(`  create permission "${definition.key}"`);
  }
}

async function seedRoles(tenantId: TenantId): Promise<void> {
  for (const seedRole of SEED_ROLES) {
    let role = await roles.getRoleByKey(tenantId, seedRole.key);
    if (!role) {
      const created = await roles.createRole({
        tenantId,
        key: seedRole.key,
        name: seedRole.name,
        description: seedRole.description,
        isSystem: true,
      });
      if (!created.ok) {
        throw created.error;
      }
      role = created.value;
      console.log(`  create role "${seedRole.key}"`);
    } else {
      console.log(`  skip   role "${seedRole.key}" (already exists)`);
    }

    for (const grant of seedRole.grants) {
      const permission = await roles.findPermissionByKey(grant.permissionKey);
      if (!permission) {
        throw new Error(`Permission "${grant.permissionKey}" not found - seedPermissionCatalogue must run first.`);
      }
      const granted = await roles.grantPermission({
        tenantId,
        roleId: role.id,
        permissionId: permission.id,
        scope: grant.scope,
      });
      if (!granted.ok) {
        throw granted.error;
      }
    }
  }
}

async function assignAdminRole(tenantId: TenantId, adminUserId: UserId): Promise<void> {
  const role = await roles.getRoleByKey(tenantId, 'school_administrator');
  if (!role) {
    throw new Error('Role "school_administrator" not found - seedRoles must run first.');
  }

  const assigned = await roles.assignRole(tenantId, { roleId: role.id, userId: adminUserId });
  if (assigned.ok) {
    console.log(`  assign role "school_administrator" to ${ADMIN_EMAIL}`);
    return;
  }
  if (assigned.error.code === 'CONFLICT') {
    // role_assignment_no_overlap (see the 0400 migration) already holds a
    // current assignment of this role to this user - exactly the idempotent
    // "already exists" outcome every other seed step checks for explicitly.
    console.log(`  skip   assignment of "school_administrator" to ${ADMIN_EMAIL} (already exists)`);
    return;
  }
  throw assigned.error;
}

async function main(): Promise<void> {
  const tenantId = await findGreenwoodTenantId();
  const adminUserId = await findAdminUserId();

  await seedPermissionCatalogue();
  await seedRoles(tenantId);
  await assignAdminRole(tenantId, adminUserId);

  console.log('seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
