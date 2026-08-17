#!/usr/bin/env tsx
/**
 * Demo logins for every seeded role that would otherwise have nobody in it.
 *
 * `@sms/identity`'s seed creates the administrator and `@sms/academic`'s creates
 * the teacher, because each is needed by the module that creates it. That left
 * six roles - Registrar, Nurse, Counsellor, Finance, Parent/Guardian, Student -
 * fully configured but impossible to sign in as, so the most interesting part of
 * the permission model could only be read off a screen rather than used:
 *
 *   * a Nurse sees medical alerts but not safeguarding ones; a Counsellor is the
 *     reverse; neither sees grades. That is field masking, and it is only
 *     observable by signing in as each.
 *   * a Parent/Guardian and a Student are `own`-scoped, which means nothing at
 *     all unless the account is linked to a person who really has children /
 *     really is enrolled.
 *
 * So each login is linked to an EXISTING seeded person chosen to make its scope
 * meaningful: the parent to a guardian who actually has children, the student to
 * an enrolled student, the staff roles to distinct staff who are not already
 * somebody's login. An account linked to an arbitrary person would appear to
 * work while proving nothing.
 *
 * Runs LAST in the seed chain: it needs people, relationships and enrolments to
 * already exist. Raw SQL for the cross-module lookups - `@sms/access` is
 * `type:platform` and may not import a `type:domain` package, the same
 * established precedent as its own reads of `identity.membership`.
 *
 * Usage: tsx src/seed-demo-logins.ts  (after every other module's seed)
 */
import 'reflect-metadata';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeSqlClients, withSystemTx } from '@sms/db';
import { newId, type TenantId, type UserId } from '@sms/kernel';
import { getAuth } from '@sms/identity';

const __dirname = join(fileURLToPath(import.meta.url), '..');

try {
  process.loadEnvFile(join(__dirname, '..', '..', '..', '..', '.env'));
} catch {
  // environment already populated
}

const PASSWORD = 'Passw0rd!demo';

type PersonPick =
  | 'guardian_with_children'
  | 'enrolled_student'
  | 'unlinked_staff'
  /** No person link needed: the role's grants are tenant-scoped and reference no person. */
  | 'none';

interface DemoLogin {
  readonly email: string;
  readonly name: string;
  readonly roleKey: string;
  readonly pick: PersonPick;
  readonly why: string;
}

const DEMO_LOGINS: DemoLogin[] = [
  {
    email: 'registrar@greenwood.test',
    name: 'Daniel Osei',
    roleKey: 'registrar',
    pick: 'unlinked_staff',
    why: 'tenant-wide people and enrolment access, no gradebook',
  },
  {
    email: 'nurse@greenwood.test',
    name: 'Grace Whittaker',
    roleKey: 'nurse',
    pick: 'unlinked_staff',
    why: 'campus-scoped: medical alerts visible, safeguarding masked, no grades',
  },
  {
    email: 'counsellor@greenwood.test',
    name: 'Marco Bianchi',
    roleKey: 'counsellor',
    pick: 'unlinked_staff',
    why: 'campus-scoped: safeguarding visible, medical masked, no grades',
  },
  {
    email: 'finance@greenwood.test',
    name: 'James Whitfield',
    roleKey: 'finance',
    // Tenant-scoped billing: nothing this role can do depends on which person
    // the account belongs to, so it does not consume one of the seeded staff.
    pick: 'none',
    why: 'billing only - proves a role can hold almost nothing',
  },
  {
    email: 'parent@greenwood.test',
    name: 'Michael Carter',
    roleKey: 'parent_guardian',
    pick: 'guardian_with_children',
    why: 'own scope - must be a guardian who really has linked children',
  },
  {
    email: 'student@greenwood.test',
    name: 'Emily Carter',
    roleKey: 'student',
    pick: 'enrolled_student',
    why: 'own scope - must be a really enrolled student',
  },
];

async function findTenantId(): Promise<TenantId> {
  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from tenancy.tenant where slug = 'greenwood' limit 1`),
  );
  const row = (rows as unknown as Array<{ id: string }>)[0];
  if (!row) {
    throw new Error('No "greenwood" tenant. Run the other seeds first.');
  }
  return row.id as TenantId;
}

/**
 * What makes each pick MEANINGFUL, as a predicate over `people.person p`.
 *
 * Used twice - to CHOOSE a person for a new login, and to RE-CHECK that an
 * existing login's person still qualifies - so the two can never drift. A
 * login whose link quietly stops satisfying its own criteria is precisely the
 * failure this file exists to prevent (see the header): it presents as an
 * empty screen and gets diagnosed as a permissions bug.
 */
function pickPredicate(pick: Exclude<PersonPick, 'none'>) {
  const currentlyEnrolled = (personColumn: ReturnType<typeof sql.raw>) => sql`
    select 1 from academic.section_enrollment se
    where se.person_id = ${personColumn} and se.tenant_id = p.tenant_id
      and se.valid_from <= current_date
      and (se.valid_to is null or se.valid_to >= current_date)
  `;

  switch (pick) {
    case 'guardian_with_children':
      // Not merely "has children": has a child they are ALLOWED to be
      // contacted about, who is enrolled TODAY. Both features filter on
      // exactly that pair - `GuardianRecipientResolverService` for
      // notifications, `AnnouncementService.resolveAudience` for announcement
      // audiences - so a guardian failing it receives nothing whatsoever and
      // the parent portal renders a blank page that looks broken.
      return sql`
        exists (select 1 from people.person_role pr where pr.person_id = p.id and pr.role = 'guardian')
        and exists (
          select 1 from people.relationship r
          where r.from_person_id = p.id and r.tenant_id = p.tenant_id
            and r.may_receive_comms = true
            and exists (${currentlyEnrolled(sql.raw('r.to_person_id'))})
        )`;
    case 'enrolled_student':
      // Enrolled TODAY, not merely enrolled once: a student whose enrolment
      // has lapsed has no timetable, no attendance and no grades to show.
      return sql`exists (${currentlyEnrolled(sql.raw('p.id'))})`;
    case 'unlinked_staff':
      return sql`exists (select 1 from people.person_role pr where pr.person_id = p.id and pr.role = 'staff')`;
  }
}

/** A person who makes this role's scope mean something, and who is not already someone's login. */
async function findPerson(tenantId: TenantId, pick: PersonPick): Promise<string | null> {
  if (pick === 'none') {
    return null;
  }

  const rows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`
      select p.id from people.person p
      where p.tenant_id = ${tenantId}
        and p.archived_at is null and p.merged_into_id is null
        and p.id not in (select person_id from identity.membership where person_id is not null)
        and ${pickPredicate(pick)}
      order by p.family_name, p.given_name limit 1
    `),
  );
  return (rows as unknown as Array<{ id: string }>)[0]?.id ?? null;
}

/**
 * Does the person a login is ALREADY linked to still satisfy its pick?
 *
 * Seed data drifts - enrolments lapse, consent flags get flipped - and a
 * demo login is only worth having while its link still demonstrates the
 * thing it was created to demonstrate.
 */
async function personStillQualifies(personId: string, pick: PersonPick): Promise<boolean> {
  if (pick === 'none') {
    return true;
  }

  const rows = await withSystemTx((db) =>
    db.execute<{ ok: boolean }>(sql`
      select true as ok from people.person p
      where p.id = ${personId}
        and p.archived_at is null and p.merged_into_id is null
        and ${pickPredicate(pick)}
    `),
  );
  return (rows as unknown as Array<{ ok: boolean }>).length > 0;
}

async function ensureLogin(tenantId: TenantId, login: DemoLogin): Promise<void> {
  const existingRows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`select id from identity.user where email = ${login.email} limit 1`),
  );
  const existing = (existingRows as unknown as Array<{ id: string }>)[0];

  let userId: UserId;
  if (existing) {
    userId = existing.id as UserId;
    console.log(`  skip   user "${login.email}" (already exists)`);
  } else {
    const result = await getAuth().api.signUpEmail({
      body: { name: login.name, email: login.email, password: PASSWORD },
    });
    userId = result.user.id as UserId;
    console.log(`  create user "${login.email}"`);
  }

  // Check the membership BEFORE looking for a person. `findPerson` deliberately
  // only returns people nobody has claimed yet, so on a re-run it correctly
  // finds nobody - and warning about that would report a problem that does not
  // exist every single time the seed is run twice.
  const membershipRows = await withSystemTx((db) =>
    db.execute<{ id: string; person_id: string | null }>(
      sql`select id, person_id from identity.membership where tenant_id = ${tenantId} and user_id = ${userId} limit 1`,
    ),
  );
  const membership = (membershipRows as unknown as Array<{ id: string; person_id: string | null }>)[0];

  // The person a login ends up linked to is CHOSEN by `findPerson`, not named
  // in `DEMO_LOGINS` - and re-linking can change it. Leaving the login's
  // display name as the hardcoded one then makes the app greet "Michael" over
  // a page listing Rosa's children, which reads as a data bug in a demo. The
  // person is the source of truth for the name; `login.name` is only a seed
  // for accounts that link to nobody.
  const syncNameToPerson = async (personId: string): Promise<void> => {
    await withSystemTx((db) =>
      db.execute(sql`
        update identity."user" u
        set name = p.given_name || ' ' || p.family_name
        from people.person p
        where p.id = ${personId}
          and u.id = ${userId}
          and u.name is distinct from p.given_name || ' ' || p.family_name
      `),
    );
  };

  if (membership) {
    // Re-check rather than assume. `findPerson` deliberately only returns
    // people nobody has claimed, so a re-run legitimately finds nobody new -
    // but an EXISTING link that no longer satisfies its own pick is a real
    // defect, and one that is invisible until someone signs in and sees an
    // empty portal.
    const stillGood = membership.person_id !== null && (await personStillQualifies(membership.person_id, login.pick));

    if (login.pick === 'none' || stillGood) {
      console.log(`  skip   membership for "${login.email}"`);
      if (membership.person_id) {
        await syncNameToPerson(membership.person_id);
      }
    } else {
      const replacement = await findPerson(tenantId, login.pick);
      if (replacement) {
        await withSystemTx((db) =>
          db.execute(sql`update identity.membership set person_id = ${replacement} where id = ${membership.id}`),
        );
        await syncNameToPerson(replacement);
        console.log(`  relink membership for "${login.email}" -> person ${replacement} (previous link failed "${login.pick}")`);
      } else {
        console.warn(`  WARN   "${login.email}" fails "${login.pick}" and no replacement person is available`);
      }
    }
  } else {
    const personId = await findPerson(tenantId, login.pick);
    if (!personId && login.pick !== 'none') {
      // Loud, not silent: a login whose scope resolves to nobody looks broken in a
      // way that is easy to mistake for a permissions bug.
      console.warn(`  WARN   no suitable person for "${login.email}" (${login.pick}) - creating the login unlinked`);
    }
    await withSystemTx((db) =>
      db.execute(sql`
        insert into identity.membership (id, tenant_id, user_id, person_id, status)
        values (${newId()}, ${tenantId}, ${userId}, ${personId}, 'active')
      `),
    );
    if (personId) {
      await syncNameToPerson(personId);
    }
    console.log(`  create membership for "${login.email}"${personId ? ` -> person ${personId}` : ''}`);
  }

  const roleRows = await withSystemTx((db) =>
    db.execute<{ id: string }>(
      sql`select id from access.role where tenant_id = ${tenantId} and key = ${login.roleKey} limit 1`,
    ),
  );
  const roleId = (roleRows as unknown as Array<{ id: string }>)[0]?.id;
  if (!roleId) {
    throw new Error(`Role "${login.roleKey}" not found - run @sms/access's seed first.`);
  }

  const assignedRows = await withSystemTx((db) =>
    db.execute<{ id: string }>(sql`
      select id from access.role_assignment
      where tenant_id = ${tenantId} and user_id = ${userId} and role_id = ${roleId}
        and (valid_to is null or valid_to >= current_date)
      limit 1
    `),
  );
  if ((assignedRows as unknown as Array<{ id: string }>)[0]) {
    console.log(`  skip   role "${login.roleKey}" for "${login.email}"`);
  } else {
    await withSystemTx((db) =>
      db.execute(sql`
        insert into access.role_assignment (id, tenant_id, role_id, user_id, valid_from)
        values (${newId()}, ${tenantId}, ${roleId}, ${userId}, current_date)
      `),
    );
    console.log(`  assign role "${login.roleKey}" to "${login.email}"`);
  }
}

async function main(): Promise<void> {
  const tenantId = await findTenantId();

  for (const login of DEMO_LOGINS) {
    await ensureLogin(tenantId, login);
  }

  console.log('\n  Demo logins (password for all: ' + PASSWORD + ')');
  for (const login of DEMO_LOGINS) {
    console.log(`    ${login.email.padEnd(30)} ${login.roleKey.padEnd(20)} ${login.why}`);
  }
  console.log('\nseed complete');
}

main()
  .catch((error: unknown) => {
    console.error('demo login seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSqlClients();
  });
